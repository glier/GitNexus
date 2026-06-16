# `bench/impact-pdg` — PDG-vs-call-graph impact accuracy harness

> **STATUS: STUB (U6).** This directory currently holds only the **curated
> ground-truth fixture corpus** (U6). The measurement harness (`measure.mjs`,
> `baselines.json`) and the full methodology write-up land in **U7**. This
> README documents the annotation schema and the validity posture so the
> fixtures are reviewable on their own.

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
| `inter-pipeline-stages` | inter | straight pipeline driver (upstream) |
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

## Annotation fingerprint (KTD10)

U7 computes an **order-independent fingerprint over this annotation set** so an
*unreviewed edit to ground truth* — which silently moves the metric — trips a
distinct `--check` gate (separate from the one-sided F1 regression band). The
canonicalizer is annotation-set-shaped (it mirrors the `bench/cfg/measure.mjs`
technique, not a literal import).

## How to run

`measure.mjs` is **not yet built** (U7). When it lands:

```
node --import tsx gitnexus/bench/impact-pdg/measure.mjs          # print the stratified report
node --import tsx gitnexus/bench/impact-pdg/measure.mjs --check  # gate against baselines.json
```

The fixtures are validated today by the integration test
`test/integration/impact-pdg-fixtures.test.ts` (schema well-formedness + a smoke
test that each fixture analyzes under `--pdg` and the criterion function
produces CDG + REACHING_DEF edges — a zero-edge criterion has unmeasurable
ground truth).
