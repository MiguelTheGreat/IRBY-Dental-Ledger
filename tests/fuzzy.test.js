'use strict';
// FR-2 / NFR-P2: typo-tolerant patient search (up to 2 character errors).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, tokenize, distance, allowedErrors, buildIndex, tokenCost, score } = require('../server/lib/fuzzy');

const MATEO = buildIndex('Mateo Lorenzo Dela Cruz');

describe('fuzzy: normalization', () => {
  it('strips accents, punctuation, case and extra whitespace', () => {
    assert.equal(normalize('  José  DELA-Cruz!! '), 'jose dela cruz');
    assert.equal(normalize('Ñiño'), 'nino');
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
  });

  it('tokenizes into words', () => {
    assert.deepEqual(tokenize('Sta. Maria,  Ana'), ['sta', 'maria', 'ana']);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('***'), []);
  });
});

describe('fuzzy: distance (optimal string alignment)', () => {
  it('computes edit distances', () => {
    assert.equal(distance('kitten', 'sitting'), 3);
    assert.equal(distance('cruz', 'cruz'), 0);
    assert.equal(distance('crz', 'cruz'), 1);
  });

  it('counts an adjacent transposition as one edit', () => {
    assert.equal(distance('ab', 'ba'), 1);
    assert.equal(distance('mtaeo', 'mateo'), 1);
  });

  it('handles empty strings', () => {
    assert.equal(distance('', 'abc'), 3);
    assert.equal(distance('abc', ''), 3);
    assert.equal(distance('', ''), 0);
  });

  it('stops early once the bound is exceeded', () => {
    assert.equal(distance('a', 'abcd', 1), 2); // length difference alone exceeds the bound
    assert.equal(distance('abcdef', 'uvwxyz', 2), 3); // row minimum exceeds the bound
    assert.equal(distance('abcd', 'abdc', 2), 1); // within the bound
  });
});

describe('fuzzy: allowed errors and index', () => {
  it('scales allowed typos with token length', () => {
    assert.equal(allowedErrors(1), 0);
    assert.equal(allowedErrors(2), 0);
    assert.equal(allowedErrors(3), 1);
    assert.equal(allowedErrors(4), 2);
    assert.equal(allowedErrors(12), 2);
  });

  it('indexes single tokens plus 2- and 3-word compounds', () => {
    assert.deepEqual(MATEO.tokens, ['mateo', 'lorenzo', 'dela', 'cruz']);
    for (const t of ['delacruz', 'lorenzodela', 'lorenzodelacruz', 'mateolorenzo', 'mateolorenzodela']) {
      assert.ok(MATEO.terms.includes(t), t);
    }
    assert.equal(new Set(MATEO.terms).size, MATEO.terms.length);
    assert.deepEqual(buildIndex('').terms, []);
  });

  it('token cost: exact 0, prefix 0.1, typo = edit count, none = Infinity', () => {
    assert.equal(tokenCost('cruz', MATEO.terms), 0);
    assert.equal(tokenCost('lor', MATEO.terms), 0.1);
    assert.equal(tokenCost('lorenso', MATEO.terms), 1);
    assert.equal(tokenCost('zz', MATEO.terms), Infinity); // too short for typos
    assert.equal(tokenCost('qqqqqq', MATEO.terms), Infinity);
  });

  it('token cost: a typo inside a partially typed name costs edits + 0.2', () => {
    const c = tokenCost('mtae', MATEO.terms); // "mtae" ~ "mate|o"
    assert.ok(Math.abs(c - 1.2) < 1e-9, `cost ${c}`);
  });
});

describe('fuzzy: score (FR-2 search)', () => {
  it('FR-2: "dela crz" still finds Mateo Lorenzo Dela Cruz', () => {
    const s = score('dela crz', MATEO);
    assert.notEqual(s, null);
    assert.equal(s, 1);
  });

  it('FR-2: exact and prefix queries rank better than typo queries', () => {
    const exact = score('mateo dela cruz', MATEO);
    const prefix = score('mat', MATEO);
    const typo = score('mateo dela kruz', MATEO);
    assert.equal(exact, 0);
    assert.equal(prefix, 0.1);
    assert.equal(typo, 1);
    assert.ok(exact < prefix && prefix < typo);
  });

  it('FR-2: up to 2 typos across the query still match', () => {
    assert.equal(score('mataeo lorenso', MATEO), 2);
    assert.equal(score('Matteo Lorenso', MATEO), 2);
  });

  it('FR-2: 3 or more typos return null', () => {
    assert.equal(score('mataeo lorenso dela kruz', MATEO), null);
    assert.equal(score('xavier', MATEO), null);
  });

  it('FR-2: compounds match with or without the space', () => {
    assert.equal(score('delacruz', MATEO), 0);
    const roberto = buildIndex('Roberto Pascual Delacruz');
    const s = score('dela cruz', roberto); // query split, record joined
    assert.notEqual(s, null);
    assert.ok(s < 1, `score ${s}`);
    assert.equal(score('dela kxyz', roberto), null);
  });

  it('empty query matches everything with score 0', () => {
    assert.equal(score('', MATEO), 0);
    assert.equal(score('   ', MATEO), 0);
  });

  it('accents and case in the query are ignored', () => {
    assert.equal(score('MATÉO', MATEO), 0);
  });
});
