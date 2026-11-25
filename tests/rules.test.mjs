import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeGenotype, dnaPayload, orphanAlleles, parseDistribution, parseGene } from '../src/rules.js';

test('parseGene requires locus.name and two alleles', () => {
  assert.equal(parseGene({ name: 'hero.cta', alleles: ['a', 'b'] }).name, 'hero.cta');
  assert.throws(() => parseGene({ name: 'hero', alleles: ['a', 'b'] }));
  assert.throws(() => parseGene({ name: 'hero.cta', alleles: ['a'] }));
});

test('parseDistribution: shares must add up to 100%', () => {
  assert.deepEqual(parseDistribution({ a: 33.33, b: 66.67 }), [
    { species_id: 'a', share_bp: 3333 },
    { species_id: 'b', share_bp: 6667 },
  ]);
  assert.throws(() => parseDistribution({ a: 50, b: 49 }), /99%/);
  assert.throws(() => parseDistribution({ a: 100.001 }));
  assert.throws(() => parseDistribution({ a: -10, b: 110 }));
  assert.throws(() => parseDistribution({}));
});

test('completeGenotype fills missing genes with allele 0 and checks ranges', () => {
  const genes = [{ name: 'a.x', alleles: 2 }, { name: 'b.y', alleles: 3 }];
  assert.deepEqual(completeGenotype(genes, { 'b.y': 2 }), { 'a.x': 0, 'b.y': 2 });
  assert.throws(() => completeGenotype(genes, { 'b.y': 3 }));
  assert.throws(() => completeGenotype(genes, { 'c.z': 0 }));
});

test('orphanAlleles finds alleles not carried by any live species', () => {
  const genes = [{ name: 'a.x', alleles: 2 }, { name: 'b.y', alleles: 3 }];
  const orphans = orphanAlleles(genes, [{ 'a.x': 0, 'b.y': 0 }, { 'a.x': 1, 'b.y': 2 }]);
  assert.deepEqual(orphans, [{ gene: 'b.y', allele: 1 }]);
});

test('dnaPayload sorts genes', () => {
  assert.equal(dnaPayload({ 'status.cta': 1, 'hero.cta': 0 }), 'hero.cta=0;status.cta=1');
});

test('planSync: create, add alleles, remove, conflicts', async () => {
  const { planSync } = await import('../src/rules.js');
  const known = [
    { name: 'a.same', alleles: 2, removed: false },
    { name: 'a.grow', alleles: 2, removed: false },
    { name: 'a.shrink', alleles: 3, removed: false },
    { name: 'a.gone', alleles: 2, removed: false },
    { name: 'a.old', alleles: 2, removed: true },
  ];
  const scanned = [
    { name: 'a.same', alleles: ['x', 'y'] },
    { name: 'a.grow', alleles: ['x', 'y', 'z'] },
    { name: 'a.shrink', alleles: ['x', 'y'] },
    { name: 'a.old', alleles: ['x', 'y'] },
    { name: 'b.new', alleles: ['x', 'y'], sources: ['index.html'] },
  ];
  const plan = planSync(scanned, known);
  assert.deepEqual(plan.create.map((g) => g.name), ['b.new']);
  assert.deepEqual(plan.add_alleles, [{ gene: 'a.grow', from: 2, labels: ['z'] }]);
  assert.deepEqual(plan.remove, ['a.gone']);
  assert.deepEqual(plan.conflicts.map((c) => c.gene), ['a.shrink', 'a.old']);
});

test('planSync refuses an empty scan and duplicates', async () => {
  const { planSync } = await import('../src/rules.js');
  assert.throws(() => planSync([], [{ name: 'a.b', alleles: 2, removed: false }]), /refusing/);
  assert.throws(() => planSync([{ name: 'a.b', alleles: ['x', 'y'] }, { name: 'a.b', alleles: ['x', 'y'] }], []), /twice/);
});
