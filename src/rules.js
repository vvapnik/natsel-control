// Pure rules of the Control Plane, free of D1 and HTTP so they can be unit-tested.

export const GENE_NAME = /^[a-z0-9-]+\.[a-z0-9-]+$/;
export const SLUG = /^[a-z0-9-]+$/;
export const TOTAL_BP = 10000; // 100% in basis points

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const bad = (msg, detail) => new HttpError(400, msg, detail);

/** Validates a new gene: `{ name, description?, alleles: [label, label, ...] }` with at least two alleles. */
export function parseGene(body) {
  const { name, description = '', alleles } = body ?? {};
  if (typeof name !== 'string' || !GENE_NAME.test(name)) throw bad('name must be <locus>.<name>');
  if (!Array.isArray(alleles) || alleles.length < 2) throw bad('a gene needs at least two alleles');
  if (!alleles.every((a) => typeof a === 'string')) throw bad('allele labels must be strings');
  return { name, description: String(description), alleles };
}

/**
 * Validates a distribution: `{ "<species id>": percent, ... }`. Percentages may have up to two
 * decimals and must add up to exactly 100. Returns `[{ species_id, share_bp }]`.
 */
export function parseDistribution(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('distribution must be an object');
  const rows = Object.entries(body).map(([species_id, pct]) => {
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) throw bad(`bad share for ${species_id}`);
    const share_bp = Math.round(pct * 100);
    if (Math.abs(share_bp - pct * 100) > 1e-6) throw bad(`share for ${species_id} has more than two decimals`);
    return { species_id, share_bp };
  });
  if (rows.length === 0) throw bad('distribution is empty');
  const total = rows.reduce((s, r) => s + r.share_bp, 0);
  if (total !== TOTAL_BP) throw bad(`shares add up to ${total / 100}%, not 100%`);
  return rows;
}

/**
 * Builds a full genotype for a new species. Genes not mentioned get allele 0.
 * `genes` is `[{ name, alleles: n }]` of live genes; `chosen` is `{ gene: allele }`.
 */
export function completeGenotype(genes, chosen = {}) {
  const known = new Map(genes.map((g) => [g.name, g.alleles]));
  for (const [gene, allele] of Object.entries(chosen)) {
    if (!known.has(gene)) throw bad(`unknown gene ${gene}`);
    if (!Number.isInteger(allele) || allele < 0 || allele >= known.get(gene)) {
      throw bad(`gene ${gene} has no allele ${allele}`);
    }
  }
  return Object.fromEntries(genes.map((g) => [g.name, chosen[g.name] ?? 0]));
}

/**
 * Invariant: every allele of every live gene is carried by at least one live species.
 * `genes` is `[{ name, alleles: n }]`, `genotypes` is `[{ gene: allele }]` of live species.
 * Returns the orphaned alleles as `[{ gene, allele }]`.
 */
export function orphanAlleles(genes, genotypes) {
  const carried = new Set(genotypes.flatMap((g) => Object.entries(g).map(([k, v]) => `${k}=${v}`)));
  const orphans = [];
  for (const g of genes) {
    for (let a = 0; a < g.alleles; a++) if (!carried.has(`${g.name}=${a}`)) orphans.push({ gene: g.name, allele: a });
  }
  return orphans;
}

/** Unsigned `dna` payload of a genotype: `gene=allele;gene=allele`, genes sorted. The Breeder signs it. */
export function dnaPayload(genotype) {
  return Object.keys(genotype)
    .sort()
    .map((g) => `${g}=${genotype[g]}`)
    .join(';');
}

/** KV snapshot the Breeder reads under `population:<id>`. */
export function snapshot(population, rows, genotypes) {
  return {
    population: population.id,
    version: population.version,
    published_at: new Date().toISOString(),
    species: rows
      .filter((r) => r.share_bp > 0)
      .map((r) => ({ id: r.species_id, share_bp: r.share_bp, dna: dnaPayload(genotypes[r.species_id]) })),
  };
}

/**
 * Plans a sync of the gene pool with the genes found in the deployed code (TASK-70.16).
 * `scanned` is `[{ name, alleles: [label] }]` from the build scanner; `known` is `[{ name, alleles: n, removed }]`
 * of every gene ever registered. Code is the source of truth, but the history is not rewritten:
 * - a gene new to the pool is created;
 * - a live gene with more alleles in the code gets the new alleles appended;
 * - a live gene missing from the code is marked removed;
 * - conflicts are reported and not applied: fewer alleles than registered (alleles are never renumbered)
 *   and a removed gene name back in the code (gene names are never reused).
 */
export function planSync(scanned, known) {
  if (!Array.isArray(scanned) || scanned.length === 0) {
    throw bad('no genes in the scan; refusing to remove every gene (use DELETE /api/genes/:name)');
  }
  const genes = scanned.map((g) => parseGene(g));
  const names = new Set();
  for (const g of genes) {
    if (names.has(g.name)) throw bad(`gene ${g.name} is listed twice`);
    names.add(g.name);
  }
  const byName = new Map(known.map((k) => [k.name, k]));
  const plan = { create: [], add_alleles: [], remove: [], conflicts: [] };
  for (const g of genes) {
    const k = byName.get(g.name);
    if (!k) plan.create.push(g);
    else if (k.removed) plan.conflicts.push({ gene: g.name, reason: 'gene was removed; gene names are never reused' });
    else if (g.alleles.length > k.alleles) {
      plan.add_alleles.push({ gene: g.name, from: k.alleles, labels: g.alleles.slice(k.alleles) });
    } else if (g.alleles.length < k.alleles) {
      plan.conflicts.push({
        gene: g.name,
        reason: `code has ${g.alleles.length} alleles, the pool ${k.alleles}; alleles are never renumbered`,
      });
    }
  }
  for (const k of known) if (!k.removed && !names.has(k.name)) plan.remove.push(k.name);
  return plan;
}
