// U7 — metric-math unit test for the impact-PDG accuracy scorer.
//
// Asserts the scorer arithmetic (precision / recall / F1 / Jaccard / set-diffs /
// aggregation / annotation fingerprint) on SYNTHETIC CIS/AIS sets ONLY — no
// `runPipelineFromRepo`, no `analyze`, no `LocalBackend`, no DB. The pure
// scorer lives in `bench/impact-pdg/metrics.mjs`, imported here directly, so
// this test is deterministic and stays OUT of the flaky full-pipeline lane
// (Arch-review Issue 5). The live substrate is exercised manually by
// `measure.mjs`, never in `npm test`.

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs pure-JS module, no types; intentional (build-free harness).
import * as M from '../../bench/impact-pdg/metrics.mjs';

const k = (sym: string, file = 'src/a.ts') => M.symbolKey(sym, file);
const setOf = (...syms: string[]) => M.toKeySet(syms.map((s) => k(s)));

describe('impact-pdg metric math — score()', () => {
  it('computes precision/recall/F1 on a known partial overlap', () => {
    // CIS = {a,b,c}, AIS = {b,c,d}. TP = {b,c} = 2.
    const cis = setOf('a', 'b', 'c');
    const ais = setOf('b', 'c', 'd');
    const s = M.score(cis, ais);
    expect(s.tp).toBe(2);
    expect(s.precision).toBeCloseTo(2 / 3, 12); // 2 of 3 predicted are real
    expect(s.recall).toBeCloseTo(2 / 3, 12); // 2 of 3 real are found
    expect(s.f1).toBeCloseTo(2 / 3, 12); // p==r ⇒ F1==p
    expect(s.fpis).toEqual([k('a')]); // CIS−AIS
    expect(s.fnis).toEqual([k('d')]); // AIS−CIS
    expect(s.fpisCount).toBe(1);
    expect(s.fnisCount).toBe(1);
    expect(s.cisAisRatio).toBeCloseTo(1, 12);
  });

  it('perfect match ⇒ P=R=F1=1, empty diffs', () => {
    const s = M.score(setOf('a', 'b'), setOf('a', 'b'));
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.fpis).toEqual([]);
    expect(s.fnis).toEqual([]);
  });

  it('asymmetric F1: high recall, low precision', () => {
    // CIS over-approximates: {a,b,c,d}, AIS = {a}. TP=1.
    const s = M.score(setOf('a', 'b', 'c', 'd'), setOf('a'));
    expect(s.precision).toBeCloseTo(1 / 4, 12);
    expect(s.recall).toBe(1);
    // F1 = 2*(0.25*1)/(0.25+1) = 0.5/1.25 = 0.4
    expect(s.f1).toBeCloseTo(0.4, 12);
    expect(s.cisAisRatio).toBeCloseTo(4, 12); // 4× over-approx
    expect(s.fpisCount).toBe(3);
    expect(s.fnisCount).toBe(0);
  });

  it('disjoint sets ⇒ P=R=F1=0', () => {
    const s = M.score(setOf('a', 'b'), setOf('c', 'd'));
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(null); // p+r==0 ⇒ harmonic mean undefined, reported n/a
    expect(s.fnis).toEqual([k('c'), k('d')]);
  });

  it('empty CIS ⇒ precision n/a (null), recall 0, F1 n/a (the PDG-intra case)', () => {
    // This is the SHAPE the real harness measures for PDG on a self-contained
    // function: the mode reports nothing, AIS = {criterion}. precision is
    // genuinely undefined (no predictions), recall is 0 (missed everything).
    const s = M.score(new Set<string>(), setOf('criterion'));
    expect(s.precision).toBe(null); // |CIS|=0 ⇒ undefined, NOT 0
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(null);
    expect(s.fnis).toEqual([k('criterion')]); // the dangerous miss
    expect(s.cisAisRatio).toBe(0);
  });

  it('empty AIS ⇒ recall n/a (null) — a scope with no ground truth', () => {
    const s = M.score(setOf('a'), new Set<string>());
    expect(s.recall).toBe(null); // |AIS|=0 ⇒ undefined, NOT 0
    expect(s.precision).toBe(0); // predicted a, none real
    expect(s.f1).toBe(null);
    expect(s.cisAisRatio).toBe(null);
  });
});

describe('impact-pdg metric math — compareModes()', () => {
  it('Jaccard + directional set-diffs split true/noise', () => {
    // callgraph finds {a,b,c} (a,b real, c noise); pdg finds {b,d} (b real, d noise).
    // AIS = {a,b,e}.
    const cg = setOf('a', 'b', 'c');
    const pdg = setOf('b', 'd');
    const ais = setOf('a', 'b', 'e');
    const cmp = M.compareModes(cg, pdg, ais);
    // union {a,b,c,d}=4, inter {b}=1 ⇒ Jaccard 1/4.
    expect(cmp.jaccard).toBeCloseTo(0.25, 12);
    expect(cmp.intersectionSize).toBe(1);
    expect(cmp.unionSize).toBe(4);
    // pdg-only = {d}; d ∉ AIS ⇒ noise.
    expect(cmp.pdgOnly.all).toEqual([k('d')]);
    expect(cmp.pdgOnly.true).toEqual([]);
    expect(cmp.pdgOnly.noise).toEqual([k('d')]);
    // callgraph-only = {a,c}; a ∈ AIS (true find pdg missed), c ∉ AIS (noise).
    expect(cmp.callgraphOnly.all).toEqual([k('a'), k('c')]);
    expect(cmp.callgraphOnly.true).toEqual([k('a')]);
    expect(cmp.callgraphOnly.noise).toEqual([k('c')]);
  });

  it('two empty CIS ⇒ Jaccard n/a (null), no diffs', () => {
    const cmp = M.compareModes(new Set<string>(), new Set<string>(), setOf('a'));
    expect(cmp.jaccard).toBe(null);
    expect(cmp.pdgOnly.all).toEqual([]);
    expect(cmp.callgraphOnly.all).toEqual([]);
  });
});

describe('impact-pdg metric math — partitionCisByScope() / aisByScope()', () => {
  it('partitions a CIS into intra (=criterion) vs inter (others)', () => {
    const critKey = k('route', 'src/mixed.ts');
    const cis = M.toKeySet([
      k('route', 'src/mixed.ts'), // the criterion itself ⇒ intra
      k('fast', 'src/mixed.ts'), // a callee ⇒ inter
      k('slow', 'src/mixed.ts'), // a callee ⇒ inter
    ]);
    const part = M.partitionCisByScope(cis, critKey);
    expect([...part.intra]).toEqual([critKey]);
    expect([...part.inter].sort()).toEqual([k('fast', 'src/mixed.ts'), k('slow', 'src/mixed.ts')]);
    expect(part.mixed.size).toBe(3);
  });

  it('aisByScope collapses intra_AIS lines onto the criterion symbol', () => {
    const gt = {
      criterion: { name: 'route', filePath: 'src/mixed.ts', direction: 'downstream' },
      intra_AIS: [
        { symbol: 'route', filePath: 'src/mixed.ts', line: 16 },
        { symbol: 'route', filePath: 'src/mixed.ts', line: 18 },
        { symbol: 'route', filePath: 'src/mixed.ts', line: 20 },
      ],
      inter_AIS: [
        { symbol: 'fast', filePath: 'src/mixed.ts' },
        { symbol: 'slow', filePath: 'src/mixed.ts' },
      ],
    };
    const a = M.aisByScope(gt);
    // three intra lines collapse to the singleton {criterion}.
    expect([...a.intra]).toEqual([k('route', 'src/mixed.ts')]);
    expect([...a.inter].sort()).toEqual([k('fast', 'src/mixed.ts'), k('slow', 'src/mixed.ts')]);
    expect(a.mixed.size).toBe(3);
  });

  it('aisByScope: empty intra_AIS ⇒ empty intra scope (no false {criterion})', () => {
    const gt = {
      criterion: { name: 'dispatch', filePath: 'src/d.ts', direction: 'downstream' },
      intra_AIS: [],
      inter_AIS: [{ symbol: 'handleA', filePath: 'src/d.ts' }],
    };
    const a = M.aisByScope(gt);
    expect(a.intra.size).toBe(0); // no intra truth ⇒ recall will be n/a, not 0
    expect([...a.inter]).toEqual([k('handleA', 'src/d.ts')]);
  });
});

describe('impact-pdg metric math — aggregate()', () => {
  it('macro-averages defined metrics, EXCLUDING nulls (not folding as 0)', () => {
    const per = [
      { precision: 1, recall: 1, f1: 1, cisAisRatio: 1, fpisCount: 0, fnisCount: 0 },
      { precision: 0.5, recall: 1, f1: 2 / 3, cisAisRatio: 2, fpisCount: 1, fnisCount: 0 },
      // a null-precision case (|CIS|=0): excluded from the precision mean.
      { precision: null, recall: 0, f1: null, cisAisRatio: 0, fpisCount: 0, fnisCount: 2 },
    ];
    const agg = M.aggregate(per);
    expect(agg.nCases).toBe(3);
    // precision mean over the 2 defined cases = (1+0.5)/2 = 0.75
    expect(agg.precision).toBeCloseTo(0.75, 12);
    expect(agg.nPrecision).toBe(2);
    // recall mean over all 3 (none null) = (1+1+0)/3
    expect(agg.recall).toBeCloseTo(2 / 3, 12);
    expect(agg.nRecall).toBe(3);
    // F1 mean over the 2 defined = (1 + 2/3)/2
    expect(agg.f1).toBeCloseTo((1 + 2 / 3) / 2, 12);
    expect(agg.nF1).toBe(2);
    expect(agg.fpis).toBe(1); // summed totals
    expect(agg.fnis).toBe(2);
  });

  it('all-null stratum ⇒ null means, n=0 (reported n/a)', () => {
    const agg = M.aggregate([{ precision: null, recall: null, f1: null, cisAisRatio: null }]);
    expect(agg.precision).toBe(null);
    expect(agg.recall).toBe(null);
    expect(agg.f1).toBe(null);
    expect(agg.nF1).toBe(0);
  });
});

describe('impact-pdg metric math — annotation fingerprint (KTD10)', () => {
  const fakeHash = (s: string): string => {
    // tiny deterministic non-crypto digest — enough to assert drift sensitivity
    // without pulling node:crypto into the unit (the real harness injects sha256).
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };
  const fx = (over: Record<string, unknown> = {}) => ({
    name: 'c1',
    gt: {
      schemaVersion: 1,
      criterion: {
        name: 'f',
        filePath: 'src/f.ts',
        direction: 'downstream',
        marker: 'x',
        pdgEdgeKinds: ['REACHING_DEF'],
      },
      locus: 'intra',
      provenance: 'manual',
      intra_AIS: [{ symbol: 'f', filePath: 'src/f.ts', line: 3 }],
      inter_AIS: [],
      ...over,
    },
  });

  it('is order-independent over the fixture list', () => {
    const a = M.fingerprintAnnotationSet([fx({}), { ...fx({}), name: 'c2' }], fakeHash);
    const b = M.fingerprintAnnotationSet([{ ...fx({}), name: 'c2' }, fx({})], fakeHash);
    expect(a).toBe(b);
  });

  it('trips when an AIS membership changes (catches unreviewed ground-truth edits)', () => {
    const base = M.fingerprintAnnotationSet([fx({})], fakeHash);
    const edited = M.fingerprintAnnotationSet(
      [fx({ intra_AIS: [{ symbol: 'f', filePath: 'src/f.ts', line: 99 }] })],
      fakeHash,
    );
    expect(edited).not.toBe(base);
  });

  it('trips when the criterion direction flips', () => {
    const base = M.fingerprintAnnotationSet([fx({})], fakeHash);
    const flipped = M.fingerprintAnnotationSet(
      [fx({ criterion: { name: 'f', filePath: 'src/f.ts', direction: 'upstream', marker: 'x', pdgEdgeKinds: ['REACHING_DEF'] } })],
      fakeHash,
    );
    expect(flipped).not.toBe(base);
  });

  it('is STABLE under a pure reordering of AIS entries within a case', () => {
    const a = M.fingerprintAnnotationSet(
      [fx({ intra_AIS: [{ symbol: 'f', filePath: 'src/f.ts', line: 3 }, { symbol: 'f', filePath: 'src/f.ts', line: 5 }] })],
      fakeHash,
    );
    const b = M.fingerprintAnnotationSet(
      [fx({ intra_AIS: [{ symbol: 'f', filePath: 'src/f.ts', line: 5 }, { symbol: 'f', filePath: 'src/f.ts', line: 3 }] })],
      fakeHash,
    );
    expect(a).toBe(b);
  });
});

describe('impact-pdg metric math — median (substrate-stability gate F5)', () => {
  it('odd/even/empty', () => {
    expect(M.median([3, 1, 2])).toBe(2);
    expect(M.median([4, 1, 3, 2])).toBe(2.5);
    expect(M.median([])).toBe(null);
  });
});
