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
