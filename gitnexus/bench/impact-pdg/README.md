# `bench/impact-pdg` — PDG-vs-call-graph impact accuracy harness

> **STATUS: LIVE (U7).** This directory holds the curated ground-truth fixture
> corpus (U6) **and** the measurement harness (`measure.mjs`, `metrics.mjs`,
> `baselines.json`). Run it with `node --import tsx bench/impact-pdg/measure.mjs`
> (build `dist/` first — see *How to run*). The harness drives both `impact`
> engines over the fixtures, prints a stratified P/R/F1 table + a plain-language
> decision recommendation, and gates regressions with `--check`.

## What this measures

`impact` has two engines: `mode: 'callgraph'` (the default — inter-procedural
BFS over symbol→symbol edges, over-approximating) and `mode: 'pdg'` (opt-in —
intra-procedural blast radius from the persisted CDG + REACHING_DEF Program
Dependence Graph). They occupy **different points on the precision/recall
curve**; neither strictly dominates. The U7 harness runs both over the fixtures
here and reports **precision / recall / F1 stratified by impact locus** so the
"which is more accurate?" question gets an honest, per-scope answer rather than
a single blended number.

## The corpus

Each case is a tiny self-contained TypeScript source repo plus a
`ground-truth.json`. TypeScript is used throughout because it has the most
mature CFG/PDG support in this codebase.

| Case | Locus | Shape |
|---|---|---|
| `intra-dataflow-accumulator` | intra | loop-carried accumulator def→use (downstream) |
| `intra-dataflow-chain` | intra | straight-line def→use chain (downstream) |
| `intra-dataflow-reassign` | intra | reaching defs of a use (upstream, RD-reverse) |
| `intra-control-guard` | intra | guard-clause control dependence (downstream, CDG-forward) |
| `intra-control-branch` | intra | if/else-if/else arm control dependence (downstream) |
| `intra-control-loop` | intra | nested loop+if controllers of a stmt (upstream, CDG-reverse) |
| `inter-dispatcher-thin` | inter | branch router → 3 handlers (PDG ≈ ∅ by design) |
| `inter-facade-delegate` | inter | guarded sequential delegation chain |
| `inter-pipeline-stages` | inter | straight pipeline driver (downstream → 3 stages) |
| `mixed-validate-then-call` | mixed | guard-dominated intra dependence + 1 callee |
| `mixed-compute-and-emit` | mixed | data-flow-dominated intra dependence + 1 callee |
| `mixed-guarded-dispatch` | mixed | control+data intra dependence + 2 callees |
| `nobody-interface-excluded` | n/a | no-body symbols (KTD6); **excluded** from PDG scoring |

**Minimum corpus floor (KTD9/F3):** ≥ 3 cases per locus stratum, ≥ 12 total
measurable cases. Current: intra = 6, inter = 3, mixed = 3 → 12 measurable
(+1 excluded no-body case). Below this floor the U7 harness must print
"underpowered — directional only" instead of a verdict.

## Annotation schema (`ground-truth.json`)

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | schema version (currently `1`) |
| `criterion` | `{ name, filePath, direction, marker?, pdgEdgeKinds? }` | the changed symbol — the seed for "what is affected if I change this". `direction` ∈ `downstream` \| `upstream`. `marker` is a substring unique to the criterion function's body (appears in one of its `BasicBlock.text` fragments); the smoke test uses it to locate the criterion function's blocks deterministically. `pdgEdgeKinds` lists the PDG edge kinds (`REACHING_DEF` \| `CDG`) the criterion function is expected to produce: a pure straight-line data-flow criterion declares only `REACHING_DEF` (no branches → no control dependence), a branching/guard criterion declares both. The smoke test asserts exactly the declared kinds are non-zero on the criterion (so the pure-dataflow archetype isn't forced to carry an artificial branch) and that the criterion produces ≥ 1 PDG edge overall (catching an accidental no-body/zero-edge criterion). `marker` and `pdgEdgeKinds` are required for every measurable case; both are omitted only on `pdgScoring: "exclude"` no-body cases. |
| `intra_AIS` | `AisEntry[]` | symbols/**lines** truly affected WITHIN the same function (the scope where PDG mode is defined). Annotated at **symbol/line granularity, never block-id** (block ids carry fragile `fnLine:fnCol:idx`). |
| `inter_AIS` | `AisEntry[]` | symbols truly affected ACROSS function boundaries (the scope where call-graph mode is defined and intra-procedural PDG is zero-by-design). |
| `locus` | `'intra' \| 'inter' \| 'mixed' \| 'n/a'` | the dominant impact locus; `n/a` only for excluded no-body cases. |
| `pdgScoring` | `'exclude'` (optional) | present (= `"exclude"`) only on no-body cases U7 must drop from PDG denominators. |
| `provenance` | `'manual' \| 'mutation'` | how the AIS was derived. **v1 is `manual` only** — the mutation track (perturb a statement, diff the changed outcomes) needs a fixture-runner + value-diff harness that does not exist yet, so it is deferred. The field stays for forward-compatibility. |
| `analyzerVersion` | string | pinned analyzer version marker (currently the `package.json` version) so ground truth versions against the analyzer. |
| `rationale` | string | prose — WHY each AIS element is in or out. This is what makes manual annotation defensible (SLICEBENCH generate-then-verify discipline). |

`AisEntry` = `{ symbol, filePath, line?, note? }`. `line` is 1-based and present
for intra entries (which are statement-granular); inter entries name a whole
symbol and omit `line`.

`intra_AIS` and `inter_AIS` are **disjoint** for every case (an intra entry is a
line within the criterion function; an inter entry is a different symbol).

## Validity threats (the two that dominate — KTD9)

1. **Ground-truth incompleteness.** A hand-annotated handful of fixtures yields
   *point estimates* over a tiny, self-admittedly incomplete corpus. One
   mis-annotation can swing F1 by a large fraction, so U7 reports findings as a
   **direction**, not a headline decimal, until the corpus grows / the mutation
   track lands.
2. **Annotation circularity.** PDG's `intra_AIS` risks being reconciled against
   the PDG traversal's own output. **Mitigation (KTD9 annotation-circularity
   guard): these annotations are written from SOURCE SEMANTICS first** — reading
   the source and reasoning about def→use / control dependence by hand — and
   reconciling against the live traversal is **U7's job (its Step 0), not the
   annotation's**. Call-graph gets no such home-field annotation, so the
   comparison is not rigged toward PDG.

## Methodology — CIS / AIS, stratified (KTD9, Arnold–Bohner)

For each fixture × mode the harness compares the mode's **CIS** (Computed Impact
Set — the symbols it reports as impacted) against the **AIS** (Actual Impact Set
— the curated ground truth), stratified by impact locus:

- **precision** = |AIS∩CIS| / |CIS| (over-approximation cost),
- **recall** = |AIS∩CIS| / |AIS| (under-approximation; the *dangerous* miss for
  a safety tool),
- **F1** = harmonic mean,
- **FPIS** = CIS − AIS (noise), **FNIS** = AIS − CIS (missed),
- **|CIS|/|AIS|** size ratio,
- cross-mode **Jaccard(callgraph_CIS, pdg_CIS)** + directional set-diffs
  (`pdg-only` / `callgraph-only`), each split into *true* (∩AIS) vs *noise*
  (−AIS).

**Empty-denominator semantics are explicit, never silently 0/1.** |CIS|=0 ⇒
precision is `n/a` (no predictions); |AIS|=0 ⇒ recall is `n/a` (no truth in that
scope). A scope with an `n/a` metric is **excluded** from that metric's mean,
never folded in as 0 — folding it as 0 would punish a mode for a scope that
simply has no ground truth (the apples-to-oranges trap, R1). The pure scorer
lives in `metrics.mjs`; its arithmetic is pinned by the deterministic unit test
`test/unit/impact-pdg-metric-math.test.ts` (synthetic sets only — no analyze, no
DB, so it stays out of the flaky full-pipeline lane).

**Granularity: symbol, never block-id.** A symbol key is `<symbol>@<filePath>`,
order-independent and line-collapsed. An `intra_AIS` statement-line collapses
onto its **owning symbol**; an `inter_AIS` entry already names a whole symbol.
This is why per-fixture intra-AIS reduces to the singleton `{criterion}`. CIS is
partitioned the same way: the criterion symbol itself = **intra** scope, every
other reported symbol = **inter** scope, the union = **mixed**.

**PDG on inter-scope AIS is known-zero-recall BY DESIGN** — a capability fact,
not a loss. v1 PDG impact is intra-procedural; it cannot reach across function
boundaries.

## Substrate (the load-bearing mechanism — R8)

`runPipelineFromRepo` is in-memory and never persists, but `impact` queries a
**persisted** `lbugPath` + a `meta.pdg` stamp; there is no exported `runAnalyze`
(the entrypoint `analyzeCommand` calls `process.exit`, unusable in a loop), and
the test-suite `vi.mock` bridge is vitest-only. So the harness runs **real
analyze via a temp `GITNEXUS_HOME`, mock-free**. Per fixture:

1. Point `process.env.GITNEXUS_HOME` at a per-run temp dir (honored by
   `repo-manager.getGlobalDir()` — it roots the registry; the per-repo DB lands
   in `<fixtureCopy>/.gitnexus/`, so fixtures are copied to a temp working dir
   first, keeping the source tree clean).
2. **Shell out** to the real CLI as a child process — child-process isolation
   sidesteps `process.exit`; real `saveMeta` + `registerRepo` land in the temp
   home; parse workers spawn from `dist/` (so the harness needs a built `dist/`):

   ```
   node --import tsx src/cli/index.ts analyze <fixtureCopy> --pdg --skip-git --index-only
   ```
3. `new LocalBackend(); await init()` resolves the fixture via the **real**
   registry (the parent process sets `GITNEXUS_HOME` too, so `init()` reads the
   temp registry, not `~/.gitnexus`).
4. `callTool('impact', {repo:<fixtureCopyPath>, target, direction, mode})` ×2
   (the absolute path is a tier-1 path match — no name collision).
5. Teardown the temp home + copy.

### Step 0 — fixture AIS validation (gated on the live traversal; circularity)

Before scoring, the harness reconciles each fixture against the live analyzer
(`metrics.mjs` is annotation-only; Step 0 is the *traversal* reconciliation):

- the criterion must produce **≥ 1 PDG edge** (an accidental no-body / cap-
  truncated criterion has unmeasurable ground truth → excluded, logged);
- the criterion symbol must **not** share `(filePath, startLine)` with another
  `Function`/`Method` (one count query) — same-line projection ambiguity (R4)
  would reconcile AIS against the wrong symbol's edges → excluded, logged.

Per the **annotation-circularity guard**, this reconciliation runs *second*: the
AIS was written from source semantics *first* (U6), and Step 0 only confirms the
fixture is measurable substrate — it never derives ground truth from the
traversal. (When the harness's per-case recall surfaced a `direction`-vs-`AIS`
contradiction in `inter-pipeline-stages` — its AIS named callees while the
criterion was tagged `upstream` — the *fixture annotation* was corrected to
`downstream`, the direction its own AIS implies; the metric was not re-fit to a
traversal.)

## Measured results (analyzer 1.6.7, 12 measurable + 1 excluded)

| Scope | Mode | P | R | F1 | \|CIS\|/\|AIS\| | FPIS | FNIS | n |
|---|---|---|---|---|---|---|---|---|
| intra | callgraph | n/a | 0.000 | n/a | 0.000 | 0 | 6 | 6 |
| intra | pdg | n/a | 0.000 | n/a | 0.000 | 0 | 6 | 6 |
| inter | callgraph | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 3 |
| inter | pdg | n/a | 0.000 | n/a | 0.000 | 0 | 9 | 3 |
| mixed | callgraph | 1.000 | 0.556 | 0.711 | 0.556 | 0 | 3 | 3 |
| mixed | pdg | n/a | 0.000 | n/a | 0.000 | 0 | 7 | 3 |

Read it honestly: **call-graph mode is exact on the cross-function questions**
(inter P/R/F1 = 1.0; mixed precision 1.0, recall 0.556 because it cannot express
the intra criterion-self component). **PDG mode reports an empty symbol-level CIS
on every measurable fixture.** That is a real property of the shipped v1
traversal, not a harness bug: PDG edges (CDG / REACHING_DEF) are *intra*-
procedural, connecting a function's own `BasicBlock`s; the traversal seeds on
**all** the criterion function's blocks and excludes seeds from the reachable
set, and the block→symbol projection collapses any intra reach back onto the
criterion itself. So at symbol granularity the intra-procedural blast radius is
∅ — PDG's v1 value is the **block-level detail** (`reachableBlocks` / `blockCount`
/ the per-edge-type reach), which the per-case lines surface (`pdg|blocks=…`),
not a symbol-level impact set.

## Decision recommendation (the verdict — F2)

> **Use `mode:'callgraph'` as the default** — it carries the inter-procedural
> reach the impact tool's safety question depends on (inter recall 1.0, mixed
> precision 1.0 on this corpus). **`mode:'pdg'` is an opt-in lens for
> intra-procedural dependence *inspection*** (its `reachableBlocks` / CDG +
> REACHING_DEF detail), valuable where the persisted PDG layer exists (`analyze
> --pdg`). It is **not** a replacement for, nor a strict improvement over, the
> call-graph blast radius: the two engines sit at different points on the
> precision/recall curve and neither strictly dominates. Promoting `mode:'pdg'`
> beyond opt-in is **gated on a `Function→BasicBlock` `CONTAINS_BLOCK` substrate
> edge** (deferred) that would let the symbol BFS chain natively into the PDG and
> give intra reach a symbol-level meaning — until then the symbol-level
> comparison is structurally one-sided and the harness says so rather than
> printing a flattering number.

## Validity threats (the two that dominate — KTD9)

1. **Ground-truth incompleteness.** A hand-annotated handful of fixtures yields
   *point estimates* over a tiny, self-admittedly incomplete corpus. One
   mis-annotation can swing F1 by a large fraction, so the harness reports
   findings as a **direction**, not a headline decimal, and prints an explicit
   "underpowered — directional only" banner when the corpus falls below the
   floor.
2. **Annotation circularity.** PDG's `intra_AIS` risks being reconciled against
   the PDG traversal's own output. **Mitigation:** these annotations are written
   from SOURCE SEMANTICS first (U6) — reading the source and reasoning about
   def→use / control dependence by hand — and reconciling against the live
   traversal is the harness's **Step 0**, run *second*, only to confirm
   measurability. Call-graph gets no such home-field annotation, so the
   comparison is not rigged toward PDG.

## Underpowered-corpus rule (F3)

**Minimum corpus floor: ≥ 3 measurable cases per locus stratum, ≥ 12 total.**
Current corpus is exactly at the floor (intra 6, inter 3, mixed 3 = 12
measurable; +1 excluded no-body). When the measurable count after exclusions
drops below the floor, the harness prints **"underpowered — directional only"**
and reports the DIRECTION ("PDG higher-precision on intra-scope") rather than
headline decimals — decimal precision (`F1 0.74 vs 0.68`) implies a confidence
the corpus cannot support.

## Annotation fingerprint + `--check` (two gates, KTD10)

`--check` runs **two non-byte-identity gates** (an exact-equality gate would go
perpetually red on legitimate accuracy changes):

1. **One-sided F1 regression band** per mode per scope: fail iff `F1 < band − ε`;
   improvements pass freely. `ε` and the per-`(scope,mode)` bands are versioned
   in `baselines.json`. A `null` band means F1 is genuinely undefined for that
   cell on this corpus (e.g. PDG's empty CIS) — the gate skips it.
2. **Order-independent annotation fingerprint** over the curated ground-truth
   set (a SHA-256 over a sorted, line-collapsed canonicalization — mirrors the
   `bench/cfg/measure.mjs` *technique*, written here, not a literal import). Any
   unreviewed edit to a `ground-truth.json` (criterion, AIS membership, locus,
   direction, edge kinds) trips it; a pure reordering of AIS entries does not.

**Substrate stability (F5).** Real analyze is the repo's flaky lane, so `--check`
applies **median-of-K** across `GN_IMPACT_PDG_K` runs *before* comparing F1 to
the band, so substrate noise can't trip the metric gate. Default K = 1 (the
fixtures are tiny and deterministic in practice); raise it
(`GN_IMPACT_PDG_K=3`) in a flaky CI lane.

## Runtime budget

Each fixture costs **one full `analyze --pdg` child process** (a fresh tree-sitter
parse + CFG/PDG build + persist) plus two in-process `impact` calls. On these
tiny fixtures that is ≈ **3–6 s/fixture**, so the full 13-fixture corpus runs in
roughly **45–80 s** wall-clock single-threaded (K = 1). A K-fold `--check`
multiplies by K. For a fast substrate smoke, scope to a subset:
`--only=intra-dataflow-chain,inter-dispatcher-thin,mixed-guarded-dispatch` (or
`GN_IMPACT_PDG_ONLY=…`). Not wired into `npm test` (matches the other benches);
the deterministic metric-math unit test *is* in `npm test`.

## How to run

```sh
cd gitnexus
node scripts/build.js                                          # REQUIRED: workers spawn from dist/
node --import tsx bench/impact-pdg/measure.mjs                 # print the stratified report + verdict
node --import tsx bench/impact-pdg/measure.mjs --json          # machine report (for re-baselining)
node --import tsx bench/impact-pdg/measure.mjs --check          # gate against baselines.json (exit non-zero on regression)
node --import tsx bench/impact-pdg/measure.mjs --only=a,b,c     # fast subset (substrate smoke)
```

### Re-baseline (after a reviewed accuracy or ground-truth change)

1. `node --import tsx bench/impact-pdg/measure.mjs --json` and read
   `annotationFingerprint` + `strata[scope][mode].f1`.
2. Copy those into `baselines.json` (`annotationFingerprint`, the `f1Bands`
   cells), bump `analyzerVersion` if the analyzer moved, adjust `epsilon` only
   deliberately.
3. Confirm `--check` is green.

The fixtures are also validated by the integration test
`test/integration/impact-pdg-fixtures.test.ts` (schema well-formedness + a smoke
test that each fixture analyzes under `--pdg` and the criterion function produces
its declared CDG / REACHING_DEF edges — a zero-edge criterion has unmeasurable
ground truth).
