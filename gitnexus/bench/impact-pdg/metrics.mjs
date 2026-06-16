/**
 * Pure scorer + annotation canonicalizer for the impact-PDG accuracy harness
 * (U7). NO substrate here — no `runPipelineFromRepo`, no `LocalBackend`, no DB,
 * no child-process `analyze`. Everything in this module is a pure function over
 * plain symbol-set inputs, so the metric-math unit test
 * (`test/unit/impact-pdg-metric-math.test.ts`) can import and assert the
 * arithmetic deterministically, staying OUT of the flaky full-pipeline lane
 * (Arch-review Issue 5). `measure.mjs` imports these for the live loop.
 *
 * ── CIS / AIS framing (KTD9 — Arnold–Bohner) ───────────────────────────────
 * CIS = Computed Impact Set: the symbols a mode REPORTS as impacted.
 * AIS = Actual Impact Set: the curated ground-truth symbols truly affected.
 *   precision = |AIS∩CIS| / |CIS|   (over-approximation cost; ∅ CIS ⇒ undefined)
 *   recall    = |AIS∩CIS| / |AIS|   (under-approximation; ∅ AIS ⇒ undefined)
 *   F1        = harmonic mean        (undefined if either is undefined)
 *   FPIS = CIS − AIS  (false positives — noise)
 *   FNIS = AIS − CIS  (false negatives — the DANGEROUS miss for a safety tool)
 *
 * ── Granularity (locked) ───────────────────────────────────────────────────
 * Symbol granularity, NEVER block-id (block ids carry fragile fnLine:fnCol:idx).
 * A symbol key is `<symbol>@<filePath>` — order-independent, line-collapsed. An
 * `intra_AIS` entry (statement-granular: lines within the criterion function)
 * collapses to its OWNING symbol; an `inter_AIS` entry already names a whole
 * symbol. This is why per-scope intra-AIS is the singleton {criterion}.
 */

/** Order-independent symbol key. Collapses statement lines onto their symbol. */
export function symbolKey(symbol, filePath) {
  return `${symbol}@${filePath}`;
}

/** Canonicalize an iterable of {symbol,filePath} (or pre-made keys) → a Set. */
export function toKeySet(entries) {
  const out = new Set();
  for (const e of entries) {
    if (typeof e === 'string') out.add(e);
    else out.add(symbolKey(e.symbol, e.filePath));
  }
  return out;
}

function intersectionSize(a, b) {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n++;
  return n;
}

/** a − b as a sorted array of keys. */
export function difference(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out.sort();
}

/**
 * Core CIS-vs-AIS scorer. `cis` / `ais` are Sets of canonical symbol keys.
 *
 * Empty-denominator semantics are EXPLICIT (not silently 0 or 1):
 *  - |CIS|=0 ⇒ precision = null (no predictions to be right/wrong about).
 *  - |AIS|=0 ⇒ recall    = null (nothing to find — this scope has no truth).
 *  - F1 = null whenever precision or recall is null OR both are 0.
 * A null metric is REPORTED as `n/a`, never averaged in as 0 — collapsing it to
 * 0 would punish a mode for a scope that simply has no ground truth (the
 * apples-to-oranges trap, R1).
 */
export function score(cis, ais) {
  const tp = intersectionSize(cis, ais);
  const precision = cis.size === 0 ? null : tp / cis.size;
  const recall = ais.size === 0 ? null : tp / ais.size;
  let f1 = null;
  if (precision !== null && recall !== null && precision + recall > 0) {
    f1 = (2 * precision * recall) / (precision + recall);
  }
  return {
    tp,
    cisSize: cis.size,
    aisSize: ais.size,
    precision,
    recall,
    f1,
    fpis: difference(cis, ais), // CIS − AIS (noise / over-approx)
    fnis: difference(ais, cis), // AIS − CIS (missed / under-approx)
    fpisCount: cis.size - tp,
    fnisCount: ais.size - tp,
    // |CIS|/|AIS| size ratio (>1 over-approximates, <1 under). null if |AIS|=0.
    cisAisRatio: ais.size === 0 ? null : cis.size / ais.size,
  };
}

/**
 * Cross-mode comparison of two CIS sets against a shared AIS (KTD9 set-diffs).
 * Jaccard(callgraph_CIS, pdg_CIS) + directional set-diffs, each split into
 * `true` (∩AIS — a real find the other mode missed) vs `noise` (−AIS — a false
 * positive the other mode avoided).
 */
export function compareModes(callgraphCis, pdgCis, ais) {
  const union = new Set([...callgraphCis, ...pdgCis]);
  const inter = intersectionSize(callgraphCis, pdgCis);
  const jaccard = union.size === 0 ? null : inter / union.size;

  const pdgOnly = difference(pdgCis, callgraphCis);
  const callgraphOnly = difference(callgraphCis, pdgCis);
  const splitByAis = (keys) => {
    const trueFinds = keys.filter((k) => ais.has(k)).sort();
    const noise = keys.filter((k) => !ais.has(k)).sort();
    return { all: keys, true: trueFinds, noise };
  };
  return {
    jaccard,
    intersectionSize: inter,
    unionSize: union.size,
    pdgOnly: splitByAis(pdgOnly),
    callgraphOnly: splitByAis(callgraphOnly),
  };
}

/**
 * Aggregate per-case scores for ONE (mode, scope) into a corpus row. Averaging
 * follows KTD9 "per change, averaged over the corpus": a case with a null metric
 * (e.g. |CIS|=0 precision) is EXCLUDED from that metric's mean (counted in
 * `nMetric`), never folded in as 0. The macro-average is over the cases that
 * actually have the metric defined; `nCases` records the stratum size for the
 * underpowered-corpus floor (F3).
 */
export function aggregate(perCaseScores) {
  const avg = (sel) => {
    const xs = perCaseScores.map(sel).filter((v) => v !== null && v !== undefined);
    if (xs.length === 0) return { mean: null, n: 0 };
    return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
  };
  const p = avg((s) => s.precision);
  const r = avg((s) => s.recall);
  const f = avg((s) => s.f1);
  const ratio = avg((s) => s.cisAisRatio);
  return {
    nCases: perCaseScores.length,
    precision: p.mean,
    nPrecision: p.n,
    recall: r.mean,
    nRecall: r.n,
    f1: f.mean,
    nF1: f.n,
    cisAisRatio: ratio.mean,
    // Summed FPIS/FNIS counts over the stratum (totals, not means) — the
    // absolute over/under-approximation volume.
    fpis: perCaseScores.reduce((a, s) => a + (s.fpisCount ?? 0), 0),
    fnis: perCaseScores.reduce((a, s) => a + (s.fnisCount ?? 0), 0),
  };
}

/**
 * Partition a mode's reported CIS keys into per-scope sub-CIS, given the
 * criterion's own symbol key. INTRA = the criterion symbol itself (the only
 * symbol whose blocks/edges are intra-procedural); INTER = every OTHER reported
 * symbol (callees / cross-function reach). `unresolved` shadow entries (id null,
 * surfaced under a file) are kept in INTER — they are non-criterion reach the
 * mode could not attribute to a named symbol, and dropping them would hide a
 * recall fact (R9). MIXED scope unions both.
 */
export function partitionCisByScope(cisKeys, criterionKey) {
  const intra = new Set();
  const inter = new Set();
  for (const k of cisKeys) {
    if (k === criterionKey) intra.add(k);
    else inter.add(k);
  }
  return { intra, inter, mixed: new Set([...intra, ...inter]) };
}

/**
 * Build the scope-appropriate AIS key sets from a ground-truth record.
 *  - intra: the criterion symbol itself (intra_AIS lines collapse onto it). A
 *    case with a non-empty intra_AIS contributes {criterion}; an empty intra_AIS
 *    contributes ∅ (no intra truth → recall n/a, not 0).
 *  - inter: the distinct callee symbols named in inter_AIS.
 *  - mixed: the union.
 * Keys are `<symbol>@<filePath>` with paths normalised to the criterion's path
 * style (the fixture annotations and the analyzer both use repo-relative
 * `src/...` paths, so no rewrite is needed — asserted by Step 0).
 */
export function aisByScope(gt) {
  const critKey = symbolKey(gt.criterion.name, gt.criterion.filePath);
  const intra = new Set();
  if (Array.isArray(gt.intra_AIS) && gt.intra_AIS.length > 0) intra.add(critKey);
  const inter = toKeySet(
    (gt.inter_AIS ?? []).map((e) => ({ symbol: e.symbol, filePath: e.filePath })),
  );
  return { criterionKey: critKey, intra, inter, mixed: new Set([...intra, ...inter]) };
}

/**
 * Order-independent annotation-set fingerprint (KTD10). Mirrors the
 * bench/cfg/measure.mjs canonicalization TECHNIQUE (sort every collection,
 * stringify deterministically, hash) — but is annotation-set-shaped and written
 * here, NOT a literal import of `canonicalizeCfg`. Any unreviewed edit to a
 * ground-truth.json (criterion, AIS membership, locus, direction, edge kinds)
 * changes the digest, tripping a `--check` gate distinct from the F1 band.
 *
 * `hash` is injected (node:crypto in the harness; a stub in the unit test) so
 * this module pulls no node-only deps that would complicate the test import.
 */
export function canonicalizeAnnotationSet(fixtures) {
  const canonAis = (entries) =>
    (entries ?? [])
      .map((e) => `${e.symbol}|${e.filePath}|${e.line ?? '-'}`)
      .sort()
      .join(';');
  const lines = fixtures
    .map((fx) => {
      const c = fx.gt.criterion;
      const kinds = Array.isArray(c.pdgEdgeKinds) ? [...c.pdgEdgeKinds].sort().join(',') : '-';
      return [
        `case=${fx.name}`,
        `schema=${fx.gt.schemaVersion}`,
        `crit=${c.name}|${c.filePath}|${c.direction}|${c.marker ?? '-'}|${kinds}`,
        `locus=${fx.gt.locus}`,
        `pdgScoring=${fx.gt.pdgScoring ?? '-'}`,
        `provenance=${fx.gt.provenance}`,
        `intra=${canonAis(fx.gt.intra_AIS)}`,
        `inter=${canonAis(fx.gt.inter_AIS)}`,
      ].join('\n');
    })
    .sort()
    .join('\n====\n');
  return lines;
}

/** SHA-256 the canonical string with an injected hashing function. */
export function fingerprintAnnotationSet(fixtures, sha256Hex) {
  return sha256Hex(canonicalizeAnnotationSet(fixtures));
}

/** median of a numeric array (substrate-stability gate, F5). */
export function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
