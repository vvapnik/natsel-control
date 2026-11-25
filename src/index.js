// natsel Control Plane (POC): gene pool, species and populations in D1; traffic distributions
// are published to KV, where the Breeder reads them. The API is behind Cloudflare Access.

import { authenticate } from './access.js';
import {
  HttpError,
  SLUG,
  completeGenotype,
  orphanAlleles,
  parseDistribution,
  parseGene,
  snapshot,
} from './rules.js';

const ok = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

// ---------- reads ----------

async function liveGenes(db) {
  const { results } = await db
    .prepare(
      `SELECT g.name, g.description, COUNT(a.idx) AS alleles, json_group_array(a.label) AS labels
       FROM genes g JOIN alleles a ON a.gene = g.name
       WHERE g.removed_at IS NULL GROUP BY g.name ORDER BY g.name`,
    )
    .all();
  return results.map((g) => ({ ...g, labels: JSON.parse(g.labels) }));
}

/** Genotypes of species over live genes: `{ species_id: { gene: allele } }`. */
async function genotypes(db, { liveOnly = true } = {}) {
  const { results } = await db
    .prepare(
      `SELECT sa.species_id, sa.gene, sa.allele FROM species_alleles sa
       JOIN genes g ON g.name = sa.gene AND g.removed_at IS NULL
       JOIN species s ON s.id = sa.species_id ${liveOnly ? 'WHERE s.extinct_at IS NULL' : ''}`,
    )
    .all();
  const out = {};
  for (const r of results) (out[r.species_id] ??= {})[r.gene] = r.allele;
  return out;
}

async function getPopulation(db, id) {
  const p = await db.prepare('SELECT * FROM populations WHERE id = ?').bind(id).first();
  if (!p) throw new HttpError(404, `no population ${id}`);
  const { results } = await db
    .prepare('SELECT species_id, share_bp FROM distributions WHERE population_id = ? ORDER BY species_id')
    .bind(id)
    .all();
  return { ...p, distribution: results };
}

// ---------- KV publishing ----------

async function publish(env, populationId) {
  const p = await getPopulation(env.DB, populationId);
  const snap = snapshot(p, p.distribution, await genotypes(env.DB, { liveOnly: false }));
  await env.DISTRIBUTIONS.put(`population:${p.id}`, JSON.stringify(snap));
  return snap;
}

async function publishAll(env) {
  const { results } = await env.DB.prepare('SELECT id FROM populations').all();
  for (const { id } of results) await publish(env, id);
}

const history = (db, actor, event, { species_id = null, population_id = null, detail = {} } = {}) =>
  db
    .prepare('INSERT INTO history (actor, event, species_id, population_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(actor, event, species_id, population_id, JSON.stringify(detail));

// ---------- handlers ----------

async function pool(env) {
  const genes = await liveGenes(env.DB);
  const gt = await genotypes(env.DB);
  return ok({ genes, species: Object.keys(gt).length, orphans: orphanAlleles(genes, Object.values(gt)) });
}

async function createGene(env, request, actor) {
  const gene = parseGene(await body(request));
  const db = env.DB;
  if (await db.prepare('SELECT 1 FROM genes WHERE name = ?').bind(gene.name).first()) {
    throw new HttpError(409, `gene ${gene.name} exists (gene names are never reused)`);
  }
  // A deployed gene already branches the code, so every live species gets it with the default allele 0.
  await db.batch([
    db.prepare('INSERT INTO genes (name, description) VALUES (?, ?)').bind(gene.name, gene.description),
    ...gene.alleles.map((label, idx) =>
      db.prepare('INSERT INTO alleles (gene, idx, label) VALUES (?, ?, ?)').bind(gene.name, idx, label),
    ),
    db
      .prepare(
        `INSERT INTO species_alleles (species_id, gene, allele) SELECT id, ?, 0 FROM species WHERE extinct_at IS NULL`,
      )
      .bind(gene.name),
    history(db, actor, 'gene.created', { detail: gene }),
  ]);
  await publishAll(env);
  return pool(env).then(async (r) => ok({ gene: gene.name, ...(await r.json()) }, 201));
}

async function removeGene(env, name, actor) {
  const res = await env.DB.prepare(`UPDATE genes SET removed_at = datetime('now') WHERE name = ? AND removed_at IS NULL`)
    .bind(name)
    .run();
  if (!res.meta.changes) throw new HttpError(404, `no live gene ${name}`);
  await history(env.DB, actor, 'gene.removed', { detail: { name } }).run();
  await publishAll(env);
  return ok({ removed: name });
}

async function listSpecies(env, url) {
  const all = url.searchParams.get('all') === '1';
  const { results } = await env.DB.prepare(
    `SELECT * FROM species ${all ? '' : 'WHERE extinct_at IS NULL'} ORDER BY created_at, id`,
  ).all();
  const gt = await genotypes(env.DB, { liveOnly: false });
  return ok(results.map((s) => ({ ...s, genotype: gt[s.id] ?? {} })));
}

async function createSpecies(env, request, actor) {
  const { name = '', parent_id = null, alleles = {} } = await body(request);
  const db = env.DB;
  const genes = await liveGenes(db);
  const genotype = completeGenotype(genes, alleles);
  const key = JSON.stringify(genotype);
  for (const [id, g] of Object.entries(await genotypes(db))) {
    if (JSON.stringify(completeGenotype(genes, g)) === key) {
      throw new HttpError(409, `species ${id} already has this genotype`);
    }
  }
  if (parent_id && !(await db.prepare('SELECT 1 FROM species WHERE id = ?').bind(parent_id).first())) {
    throw new HttpError(400, `no parent species ${parent_id}`);
  }
  const id = `sp-${crypto.randomUUID().slice(0, 8)}`;
  await db.batch([
    db.prepare('INSERT INTO species (id, name, parent_id) VALUES (?, ?, ?)').bind(id, String(name), parent_id),
    ...Object.entries(genotype).map(([gene, allele]) =>
      db.prepare('INSERT INTO species_alleles (species_id, gene, allele) VALUES (?, ?, ?)').bind(id, gene, allele),
    ),
    history(db, actor, 'species.created', { species_id: id, detail: { parent_id, genotype } }),
  ]);
  return ok({ id, name, parent_id, genotype }, 201);
}

async function extinctSpecies(env, id, actor) {
  const db = env.DB;
  const s = await db.prepare('SELECT * FROM species WHERE id = ? AND extinct_at IS NULL').bind(id).first();
  if (!s) throw new HttpError(404, `no live species ${id}`);
  const { results: used } = await db
    .prepare('SELECT population_id FROM distributions WHERE species_id = ? AND share_bp > 0')
    .bind(id)
    .all();
  if (used.length) {
    throw new HttpError(409, 'species still has traffic; set its share to 0 first', used.map((u) => u.population_id));
  }
  const gt = await genotypes(db);
  const genes = await liveGenes(db);
  const before = new Set(orphanAlleles(genes, Object.values(gt)).map((o) => `${o.gene}=${o.allele}`));
  delete gt[id];
  const lost = orphanAlleles(genes, Object.values(gt)).filter((o) => !before.has(`${o.gene}=${o.allele}`));
  if (lost.length) throw new HttpError(409, 'species is the last carrier of these alleles', lost);
  await db.batch([
    db.prepare(`UPDATE species SET extinct_at = datetime('now') WHERE id = ?`).bind(id),
    db.prepare('DELETE FROM distributions WHERE species_id = ?').bind(id),
    history(db, actor, 'species.extinct', { species_id: id }),
  ]);
  return ok({ extinct: id });
}

async function speciesHistory(env, id) {
  const { results } = await env.DB.prepare('SELECT * FROM history WHERE species_id = ? ORDER BY id').bind(id).all();
  return ok(results.map((h) => ({ ...h, detail: JSON.parse(h.detail) })));
}

async function createPopulation(env, request, actor) {
  const { id, name = '' } = await body(request);
  if (typeof id !== 'string' || !SLUG.test(id)) throw new HttpError(400, 'id must be a lowercase slug');
  if (await env.DB.prepare('SELECT 1 FROM populations WHERE id = ?').bind(id).first()) {
    throw new HttpError(409, `population ${id} exists`);
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO populations (id, name) VALUES (?, ?)').bind(id, String(name)),
    history(env.DB, actor, 'population.created', { population_id: id }),
  ]);
  return ok(await getPopulation(env.DB, id), 201);
}

async function deletePopulation(env, id, actor) {
  await getPopulation(env.DB, id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM distributions WHERE population_id = ?').bind(id),
    env.DB.prepare('DELETE FROM populations WHERE id = ?').bind(id),
    history(env.DB, actor, 'population.deleted', { population_id: id }),
  ]);
  await env.DISTRIBUTIONS.delete(`population:${id}`);
  return ok({ deleted: id });
}

async function setDistribution(env, id, request, actor) {
  const db = env.DB;
  await getPopulation(db, id);
  const rows = parseDistribution(await body(request));
  const live = await genotypes(db);
  const dead = rows.filter((r) => !live[r.species_id]).map((r) => r.species_id);
  if (dead.length) throw new HttpError(400, 'unknown or extinct species', dead);
  await db.batch([
    db.prepare('DELETE FROM distributions WHERE population_id = ?').bind(id),
    ...rows.map((r) =>
      db
        .prepare('INSERT INTO distributions (population_id, species_id, share_bp) VALUES (?, ?, ?)')
        .bind(id, r.species_id, r.share_bp),
    ),
    db.prepare('UPDATE populations SET version = version + 1 WHERE id = ?').bind(id),
    history(db, actor, 'distribution.set', { population_id: id, detail: rows }),
  ]);
  return ok(await publish(env, id));
}

// ---------- router ----------

async function route(request, env) {
  const url = new URL(request.url);
  const actor = await authenticate(request, env);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const m = request.method;
  const [res, id, sub] = parts;

  if (res === 'pool' && !id && m === 'GET') return pool(env);
  if (res === 'genes') {
    if (!id && m === 'GET') return ok(await liveGenes(env.DB));
    if (!id && m === 'POST') return createGene(env, request, actor);
    if (id && !sub && m === 'DELETE') return removeGene(env, id, actor);
  }
  if (res === 'species') {
    if (!id && m === 'GET') return listSpecies(env, url);
    if (!id && m === 'POST') return createSpecies(env, request, actor);
    if (id && sub === 'extinct' && m === 'POST') return extinctSpecies(env, id, actor);
    if (id && sub === 'history' && m === 'GET') return speciesHistory(env, id);
  }
  if (res === 'populations') {
    if (!id && m === 'GET') return ok((await env.DB.prepare('SELECT * FROM populations ORDER BY id').all()).results);
    if (!id && m === 'POST') return createPopulation(env, request, actor);
    if (id && !sub && m === 'GET') return ok(await getPopulation(env.DB, id));
    if (id && !sub && m === 'DELETE') return deletePopulation(env, id, actor);
    if (id && sub === 'distribution' && m === 'PUT') return setDistribution(env, id, request, actor);
    if (id && sub === 'snapshot' && m === 'GET') {
      return ok(JSON.parse((await env.DISTRIBUTIONS.get(`population:${id}`)) ?? 'null'));
    }
  }
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) return ok({ error: e.message, detail: e.detail }, e.status);
      console.error(e);
      return ok({ error: 'internal error' }, 500);
    }
  },
};
