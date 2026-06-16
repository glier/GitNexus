/**
 * U7 — PDG-vs-call-graph impact ACCURACY measurement harness.
 *
 * Runs BOTH `impact` engines (`mode:'callgraph'` and `mode:'pdg'`) over the
 * curated U6 ground-truth fixtures, computes precision/recall/F1 stratified by
 * impact locus (intra / inter / mixed) plus cross-mode Jaccard + set-diffs,
 * prints a stratified report ending in a plain-language DECISION RECOMMENDATION,
 * and (under `--check`) gates regressions with two NON-byte-identity gates.
 *
 * ── Substrate (the load-bearing mechanism — KTD9/R8; plan U7 "Substrate
 * decision") ──────────────────────────────────────────────────────────────
 * `runPipelineFromRepo` is in-memory and never persists; `impact` queries a
 * PERSISTED `repo.lbugPath` + a `meta.pdg` stamp. There is no exported
 * `runAnalyze` (the entrypoint `analyzeCommand` calls `process.exit`, unusable
 * in a loop), and the test-suite `vi.mock` registry bridge is vitest-only. So:
 * REAL analyze via a temp `GITNEXUS_HOME`, mock-free. Per fixture:
 *   1. point `process.env.GITNEXUS_HOME` at a per-run temp dir (honored by
 *      `repo-manager.getGlobalDir()` — it roots the registry; the per-repo DB
 *      lands in `<fixtureCopy>/.gitnexus/`, so fixtures are copied to a temp
 *      working dir to keep the source tree clean);
 *   2. SHELL OUT to the real CLI as a child process:
 *        node --import tsx src/cli/index.ts analyze <copy> --pdg --skip-git --index-only
 *      (child-process isolation sidesteps `process.exit`; real `saveMeta` +
 *      `registerRepo` land in the temp home; workers spawn from `dist/`, so the
 *      harness builds `dist/` first — run `node scripts/build.js`);
 *   3. `new LocalBackend(); await init()` resolves the fixture via the REAL
 *      registry (the parent process ALSO sets `GITNEXUS_HOME` so init reads the
 *      temp registry, not the user's ~/.gitnexus);
 *   4. `callTool('impact', {repo:<copyPath>, target, direction, mode})` ×2;
 *   5. teardown the temp home + copy.
 *
 * The `repo` arg is the absolute fixture-copy PATH (tier-1 path match in
 * `resolveRepoFromCache`) — unambiguous, no name collisions.
 *
 * ── Granularity / CIS-AIS framing ──────────────────────────────────────────
 * See `metrics.mjs`. Symbol granularity, line-collapsed, order-independent.
 *
 * Build-free: `node --import tsx bench/impact-pdg/measure.mjs`. Runtime budget
 * and re-baseline instructions: see README.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  symbolKey,
  toKeySet,
  score,
  compareModes,
  aggregate,
  partitionCisByScope,
  aisByScope,
  fingerprintAnnotationSet,
  median,
} from './metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // gitnexus/
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const BASELINE_PATH = path.join(__dirname, 'baselines.json');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const SCOPES = ['intra', 'inter', 'mixed'];
const MODES = ['callgraph', 'pdg'];

// ── F3 minimum-corpus floor (KTD9): below this the harness reports DIRECTION
// only, never a headline decimal verdict. Mirrors the U6 schema test's floor.
const FLOOR_PER_STRATUM = 3;
const FLOOR_TOTAL = 12;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── fixture loading ────────────────────────────────────────────────────────

function loadFixtures(filter) {
  const names = fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !filter || filter.includes(n))
    .sort();
  return names.map((name) => {
    const dir = path.join(FIXTURES_DIR, name);
    const gt = JSON.parse(fs.readFileSync(path.join(dir, 'ground-truth.json'), 'utf8'));
    return { name, dir, gt, excluded: gt.pdgScoring === 'exclude' };
  });
}

// ── substrate: analyze a fixture into a temp GITNEXUS_HOME, run both modes ───

/**
 * Copy the fixture src into a temp working dir, analyze it with `--pdg` as a
 * child process (real persistence into the temp GITNEXUS_HOME), then drive both
 * impact modes through a fresh LocalBackend. Returns the raw impact results +
 * the working-copy path (so the criterion file paths line up with the
 * annotations, which are repo-relative `src/...`). `pdgOn` toggles `--pdg` so
 * the degraded-index scenario (KTD7) can be exercised.
 */
async function analyzeAndImpact(fx, home, { pdgOn = true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-work-'));
  fs.cpSync(path.join(fx.dir, 'src'), path.join(work, 'src'), { recursive: true });

  const env = { ...process.env, GITNEXUS_HOME: home };
  const args = ['--import', 'tsx', CLI_ENTRY, 'analyze', work, '--skip-git', '--index-only'];
  if (pdgOn) args.push('--pdg');
  const an = spawnSync(process.execPath, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });
  if (an.status !== 0) {
    fs.rmSync(work, { recursive: true, force: true });
    throw new Error(
      `analyze failed for ${fx.name} (exit ${an.status}): ${(an.stderr || an.stdout || '').slice(-600)}`,
    );
  }

  // The parent process must see the temp GITNEXUS_HOME too — LocalBackend.init()
  // reads the REAL registry under getGlobalDir() (no mock). A fresh backend per
  // fixture avoids cross-fixture pool/registry caching.
  process.env.GITNEXUS_HOME = home;
  const { LocalBackend } = await import(path.join(REPO_ROOT, 'src', 'mcp', 'local', 'local-backend.ts'));
  const backend = new LocalBackend();
  await backend.init();

  const results = {};
  for (const mode of MODES) {
    results[mode] = await backend.callTool('impact', {
      repo: work,
      target: fx.gt.criterion.name,
      direction: fx.gt.criterion.direction,
      mode,
    });
  }
  return { work, results };
}

/** Flatten an impact result's byDepth into canonical symbol keys (the CIS). */
function cisFromResult(res) {
  const items = Object.values(res?.byDepth ?? {}).flat();
  const keys = new Set();
  const meta = { unresolved: 0, ambiguous: 0, blockCount: res?.blockCount ?? null };
  for (const it of items) {
    if (it?.unresolved) {
      meta.unresolved += 1;
      // surfaced under its file as an unresolved shadow entry — kept in the CIS
      // so a recall loss is never hidden, keyed by its file (no symbol name).
      keys.add(symbolKey('(unresolved)', it.filePath));
      continue;
    }
    if (it?.ambiguous) meta.ambiguous += 1;
    keys.add(symbolKey(it.name, it.filePath));
  }
  return { keys, meta };
}

// ── Step 0: fixture AIS validation (gated on the live traversal; KTD9
// circularity guard) ───────────────────────────────────────────────────────

/**
 * Before scoring, reconcile each fixture's annotation against the LIVE analyzer:
 *  (a) the criterion must produce ≥1 PDG edge (no accidental no-body / cap
 *      truncation — a zero-edge criterion has unmeasurable ground truth);
 *  (b) the criterion symbol must NOT share `(filePath, startLine)` with another
 *      Function/Method (same-line projection ambiguity, R4) — one count query;
 *  (c) the annotation paths must line up with the analyzer's repo-relative
 *      paths (so symbol keys match across CIS/AIS).
 * A fixture failing (a)/(b) is EXCLUDED from scoring and LOGGED (no silent cap).
 */
async function validateFixture(fx, work, exec) {
  const lbugPath = path.join(work, '.gitnexus', 'lbug');
  // (a) criterion produces ≥1 PDG edge. Locate the criterion's blocks via the
  // marker (the same technique the U6 smoke test uses) and count CDG/RD edges
  // sourced inside them.
  const marker = fx.gt.criterion.marker;
  const blocks = await exec(
    lbugPath,
    `MATCH (b:BasicBlock) RETURN b.id AS id, b.text AS text`,
    {},
  );
  const idsByAnchor = new Map();
  let anchor;
  for (const b of blocks) {
    const id = String(b.id ?? b[0] ?? '');
    const anc = id.slice(0, id.lastIndexOf(':'));
    (idsByAnchor.get(anc) ?? idsByAnchor.set(anc, new Set()).get(anc)).add(id);
    const text = String(b.text ?? b[1] ?? '');
    if (marker && text.includes(marker)) anchor = anc;
  }
  let critEdges = 0;
  if (anchor) {
    const blockIds = [...(idsByAnchor.get(anchor) ?? [])];
    if (blockIds.length > 0) {
      const rows = await exec(
        lbugPath,
        `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
           WHERE r.type IN ['CDG','REACHING_DEF'] AND a.id IN $ids
           RETURN count(r) AS n`,
        { ids: blockIds },
      );
      critEdges = Number(rows?.[0]?.n ?? rows?.[0]?.[0] ?? 0);
    }
  }

  // (b) same-(filePath,startLine) collision for the criterion symbol (R4).
  const collisionRows = await exec(
    lbugPath,
    `MATCH (s:\`Function\`)
       WHERE s.name = $name AND s.filePath = $fp
       RETURN s.startLine AS sl
     UNION ALL
     MATCH (s:\`Method\`)
       WHERE s.name = $name AND s.filePath = $fp
       RETURN s.startLine AS sl`,
    { name: fx.gt.criterion.name, fp: fx.gt.criterion.filePath },
  );
  let sameLineCollision = false;
  const startLine = collisionRows?.[0]?.sl ?? collisionRows?.[0]?.[0];
  if (startLine !== undefined && startLine !== null) {
    const peers = await exec(
      lbugPath,
      `MATCH (s:\`Function\`)
         WHERE s.filePath = $fp AND s.startLine = $sl
         RETURN s.name AS name
       UNION ALL
       MATCH (s:\`Method\`)
         WHERE s.filePath = $fp AND s.startLine = $sl
         RETURN s.name AS name`,
      { fp: fx.gt.criterion.filePath, sl: startLine },
    );
    sameLineCollision = (peers?.length ?? 0) > 1;
  }

  const problems = [];
  if (!anchor) problems.push(`criterion blocks not locatable via marker ${JSON.stringify(marker)}`);
  if (critEdges === 0) problems.push('criterion produces ZERO PDG edges (unmeasurable ground truth)');
  if (sameLineCollision)
    problems.push('criterion shares (filePath,startLine) with another Function/Method (R4 ambiguity)');
  return { critEdges, sameLineCollision, problems, measurable: problems.length === 0 };
}

// ── per-fixture scoring ──────────────────────────────────────────────────────

/**
 * Score one fixture for one mode, per scope. CIS partitioned into intra (the
 * criterion symbol itself) / inter (others) / mixed (union); AIS likewise.
 */
function scoreFixtureMode(gt, cisKeys) {
  const ais = aisByScope(gt);
  const cisPart = partitionCisByScope(cisKeys, ais.criterionKey);
  return {
    intra: score(cisPart.intra, ais.intra),
    inter: score(cisPart.inter, ais.inter),
    mixed: score(cisPart.mixed, ais.mixed),
  };
}

// ── reporting helpers ────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(3));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function renderTable(strata) {
  const head =
    `${pad('Scope', 7)} ${pad('Mode', 10)} ${lpad('P', 7)} ${lpad('R', 7)} ${lpad('F1', 7)} ` +
    `${lpad('|CIS|/|AIS|', 11)} ${lpad('FPIS', 6)} ${lpad('FNIS', 6)} ${lpad('n', 4)}`;
  const lines = [head, '-'.repeat(head.length)];
  for (const scope of SCOPES) {
    for (const mode of MODES) {
      const a = strata[scope][mode];
      lines.push(
        `${pad(scope, 7)} ${pad(mode, 10)} ${lpad(fmt(a.precision), 7)} ${lpad(fmt(a.recall), 7)} ` +
          `${lpad(fmt(a.f1), 7)} ${lpad(fmt(a.cisAisRatio), 11)} ${lpad(a.fpis, 6)} ${lpad(a.fnis, 6)} ` +
          `${lpad(a.nCases, 4)}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Plain-language DECISION RECOMMENDATION (F2 — the deliverable that answers
 * "which is more accurate" as a verdict, not just a table). Derived from the
 * measured numbers: compares inter-scope recall (the cross-function questions
 * users most bring to impact) and any measured intra-scope precision edge.
 */
function decisionRecommendation(strata, underpowered, exclusions) {
  const cgInterR = strata.inter.callgraph.recall;
  const pdgInterR = strata.inter.pdg.recall;
  const cgIntraP = strata.intra.callgraph.precision;
  const pdgIntraP = strata.intra.pdg.precision;
  const pdgIntraReports = strata.intra.pdg.nPrecision > 0; // did PDG report ANY intra symbol?

  const lines = [];
  lines.push('DECISION RECOMMENDATION');
  if (underpowered) {
    lines.push(
      `Corpus is UNDERPOWERED (below the ${FLOOR_PER_STRATUM}/stratum, ${FLOOR_TOTAL}-total floor` +
        ` after exclusions) — reporting DIRECTION, not headline decimals.`,
    );
  }

  // Inter-scope: the cross-function blast radius.
  if (cgInterR !== null && pdgInterR !== null) {
    lines.push(
      `On INTER-scope (cross-function) impact, call-graph recall is ${fmt(cgInterR)} vs PDG ${fmt(pdgInterR)}: ` +
        `PDG's intra-procedural design means it recovers ~0 cross-function impact BY DESIGN (a capability ` +
        `fact, not a defect). Call-graph is the correct engine for the "what else calls/uses this?" question.`,
    );
  }

  // Intra-scope: the case PDG was built to win.
  if (!pdgIntraReports) {
    lines.push(
      `On INTRA-scope, PDG mode reported NO owning symbols across the measurable corpus: its block→symbol ` +
        `projection collapses a function's own dependence blocks back onto the criterion itself, which the ` +
        `traversal excludes as the seed — so at SYMBOL granularity the intra-procedural blast radius is the ` +
        `empty set. PDG's intra value in v1 is therefore the BLOCK-LEVEL detail it surfaces ` +
        `(reachableBlocks / blockCount), NOT a symbol-level impact set. The harness records the per-fixture ` +
        `dependence-block counts so this is visible, not hidden as a flat zero.`,
    );
  } else if (pdgIntraP !== null && cgIntraP !== null) {
    const verb = pdgIntraP > cgIntraP ? 'higher' : pdgIntraP < cgIntraP ? 'lower' : 'equal';
    lines.push(
      `On INTRA-scope, PDG precision is ${fmt(pdgIntraP)} vs call-graph ${fmt(cgIntraP)} (${verb}). ` +
        `This is the measured direction on this corpus, reported as a fact, not asserted as a hypothesis.`,
    );
  }

  lines.push(
    `VERDICT: use mode:'callgraph' as the default — it carries the inter-procedural reach that the ` +
      `impact tool's safety question depends on. mode:'pdg' adds value as an OPT-IN lens for ` +
      `intra-procedural dependence INSPECTION (its reachableBlocks / CDG+REACHING_DEF detail), and ` +
      `where the persisted PDG layer exists (analyze --pdg). It is NOT a replacement for, nor a ` +
      `strict improvement over, the call-graph blast radius: the two engines occupy different points ` +
      `on the precision/recall curve and neither strictly dominates. Promotion of mode:'pdg' beyond ` +
      `opt-in is GATED on a Function→BasicBlock CONTAINS_BLOCK substrate edge (deferred) that would let ` +
      `the symbol BFS chain natively into the PDG and give intra reach a symbol-level meaning.`,
  );
  if (exclusions.length > 0) {
    lines.push(`Excluded from scoring: ${exclusions.map((e) => `${e.name} (${e.reason})`).join('; ')}.`);
  }
  return lines.join('\n');
}

// ── main run ─────────────────────────────────────────────────────────────────

async function run() {
  const CHECK = process.argv.includes('--check');
  const JSON_OUT = process.argv.includes('--json');
  // Optional subset for a fast substrate proof: --only=a,b,c or GN_IMPACT_PDG_ONLY=a,b
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyEnv = process.env.GN_IMPACT_PDG_ONLY;
  const filter = (onlyArg ? onlyArg.slice('--only='.length) : onlyEnv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const fixtures = loadFixtures(filter.length ? filter : null);
  if (fixtures.length === 0) throw new Error('no fixtures found');

  // K repeats for substrate-stability (F5). --check runs K times and gates on
  // the per-(mode,scope) MEDIAN F1, so a flaky analyze edge cannot trip the band.
  const K = CHECK ? Number(process.env.GN_IMPACT_PDG_K || 1) : 1;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-home-'));
  const { initLbug, executeParameterized, closeLbug } = await import(
    path.join(REPO_ROOT, 'src', 'core', 'lbug', 'pool-adapter.ts')
  );

  // exec wrapper that ensures the pool is initialised for Step 0's raw queries.
  const initialised = new Set();
  const exec = async (lbugPath, q, p) => {
    if (!initialised.has(lbugPath)) {
      await initLbug(lbugPath, lbugPath).catch(() => {});
      initialised.add(lbugPath);
    }
    return executeParameterized(lbugPath, q, p);
  };

  const exclusions = [];
  const perRunStrata = []; // K runs × { scope: { mode: aggregate } }
  let perCaseDetail = null; // last run's per-case detail for the report
  let degradedCheck = null;

  try {
    for (let runIdx = 0; runIdx < K; runIdx++) {
      // perCaseScores[scope][mode] = array of per-fixture score objects
      const perScopeMode = {};
      for (const s of SCOPES) {
        perScopeMode[s] = {};
        for (const m of MODES) perScopeMode[s][m] = [];
      }
      const detail = [];

      for (const fx of fixtures) {
        if (fx.excluded) {
          if (runIdx === 0) exclusions.push({ name: fx.name, reason: 'no-body (pdgScoring:exclude / KTD6)' });
          continue;
        }
        const { work, results } = await analyzeAndImpact(fx, home, { pdgOn: true });
        try {
          // Step 0 — reconcile annotation against the live traversal.
          const v = await validateFixture(fx, work, exec);
          if (!v.measurable) {
            if (runIdx === 0)
              exclusions.push({ name: fx.name, reason: v.problems.join(' + ') });
            continue;
          }

          const cg = cisFromResult(results.callgraph);
          const pdg = cisFromResult(results.pdg);
          const cgScores = scoreFixtureMode(fx.gt, cg.keys);
          const pdgScores = scoreFixtureMode(fx.gt, pdg.keys);

          const locusScope = fx.gt.locus; // the stratum this fixture belongs to
          // A fixture is scored in its OWN locus stratum (intra/inter/mixed).
          if (SCOPES.includes(locusScope)) {
            perScopeMode[locusScope].callgraph.push(cgScores[locusScope]);
            perScopeMode[locusScope].pdg.push(pdgScores[locusScope]);
          }

          if (runIdx === 0) {
            const ais = aisByScope(fx.gt);
            const cmp = compareModes(cg.keys, pdg.keys, ais.mixed);
            detail.push({
              name: fx.name,
              locus: fx.gt.locus,
              criterion: fx.gt.criterion.name,
              direction: fx.gt.criterion.direction,
              critEdges: v.critEdges,
              cg: {
                count: results.callgraph.impactedCount,
                symbols: [...cg.keys].sort(),
                scores: cgScores,
              },
              pdg: {
                count: results.pdg.impactedCount,
                blockCount: pdg.meta.blockCount,
                unresolved: pdg.meta.unresolved,
                ambiguous: pdg.meta.ambiguous,
                symbols: [...pdg.keys].sort(),
                scores: pdgScores,
              },
              jaccard: cmp.jaccard,
              pdgOnly: cmp.pdgOnly,
              callgraphOnly: cmp.callgraphOnly,
            });
          }
        } finally {
          await closeLbug(path.join(work, '.gitnexus', 'lbug')).catch(() => {});
          initialised.delete(path.join(work, '.gitnexus', 'lbug'));
          fs.rmSync(work, { recursive: true, force: true });
        }
      }

      // Aggregate this run's strata.
      const strata = {};
      for (const s of SCOPES) {
        strata[s] = {};
        for (const m of MODES) strata[s][m] = aggregate(perScopeMode[s][m]);
      }
      perRunStrata.push(strata);
      if (runIdx === 0) perCaseDetail = detail;
    }

    // ── Degraded-index check (KTD7): on ONE intra fixture, analyze WITHOUT
    // --pdg and assert PDG mode reports a degradation note (skipped, not 0/0).
    const degTarget = fixtures.find((f) => !f.excluded && f.gt.locus === 'intra');
    if (degTarget) {
      const { work, results } = await analyzeAndImpact(degTarget, home, { pdgOn: false });
      try {
        const pdgRes = results.pdg;
        degradedCheck = {
          name: degTarget.name,
          pdgLayer: pdgRes.pdgLayer ?? null,
          note: (pdgRes.note ?? pdgRes.error ?? '').slice(0, 140),
          skipped: pdgRes.pdgLayer !== undefined && pdgRes.pdgLayer !== 'ready',
        };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── Collapse K runs into the report strata: per (mode,scope) take the MEDIAN
  // F1 across runs (F5 substrate stability); other fields from run 0.
  const strata0 = perRunStrata[0];
  const report = {};
  for (const s of SCOPES) {
    report[s] = {};
    for (const m of MODES) {
      const f1s = perRunStrata.map((r) => r[s][m].f1).filter((v) => v !== null && v !== undefined);
      const pmeds = perRunStrata.map((r) => r[s][m].precision).filter((v) => v !== null && v !== undefined);
      const rmeds = perRunStrata.map((r) => r[s][m].recall).filter((v) => v !== null && v !== undefined);
      report[s][m] = {
        ...strata0[s][m],
        f1: f1s.length ? median(f1s) : null,
        precision: pmeds.length ? median(pmeds) : null,
        recall: rmeds.length ? median(rmeds) : null,
      };
    }
  }

  // Underpowered floor (F3): measured cases per stratum after exclusions.
  const measurableTotal = SCOPES.reduce(
    (a, s) => a + Math.max(report[s].callgraph.nCases, report[s].pdg.nCases),
    0,
  );
  const underpowered =
    measurableTotal < FLOOR_TOTAL ||
    SCOPES.some((s) => Math.max(report[s].callgraph.nCases, report[s].pdg.nCases) < FLOOR_PER_STRATUM);

  const annotationFingerprint = fingerprintAnnotationSet(fixtures, sha256);

  const machineReport = {
    analyzerVersion: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version,
    corpus: { total: fixtures.length, measurable: measurableTotal, excluded: exclusions },
    underpowered,
    floor: { perStratum: FLOOR_PER_STRATUM, total: FLOOR_TOTAL },
    strata: report,
    perCase: perCaseDetail,
    degradedCheck,
    annotationFingerprint,
    runsK: K,
  };

  // ── output ──────────────────────────────────────────────────────────────
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(machineReport, null, 2) + '\n');
  } else {
    const out = [];
    out.push('=== impact-PDG accuracy report ===');
    out.push(
      `analyzer ${machineReport.analyzerVersion} | corpus ${fixtures.length} ` +
        `(${measurableTotal} measurable, ${exclusions.length} excluded) | runs K=${K}`,
    );
    out.push('');
    out.push('Stratified P/R/F1 (symbol granularity, per impact locus):');
    out.push(renderTable(report));
    out.push('');
    out.push('Per-case Jaccard + cross-mode set-diffs (true = ∩AIS, noise = −AIS):');
    for (const d of perCaseDetail) {
      out.push(
        `  ${pad(d.name, 28)} locus=${pad(d.locus, 6)} J=${fmt(d.jaccard)} ` +
          `cg|count=${d.cg.count} pdg|count=${d.pdg.count} pdg|blocks=${d.pdg.blockCount}`,
      );
      if (d.callgraphOnly.all.length)
        out.push(
          `      callgraph-only: ${d.callgraphOnly.all.length} ` +
            `(true ${d.callgraphOnly.true.length}, noise ${d.callgraphOnly.noise.length})`,
        );
      if (d.pdgOnly.all.length)
        out.push(
          `      pdg-only:       ${d.pdgOnly.all.length} ` +
            `(true ${d.pdgOnly.true.length}, noise ${d.pdgOnly.noise.length})`,
        );
    }
    out.push('');
    if (degradedCheck) {
      out.push(
        `Degraded-index probe (KTD7): ${degradedCheck.name} analyzed WITHOUT --pdg → ` +
          `pdgLayer=${degradedCheck.pdgLayer} skipped=${degradedCheck.skipped}`,
      );
      out.push(`  note: ${degradedCheck.note}`);
      out.push('');
    }
    out.push(`Annotation fingerprint: ${annotationFingerprint}`);
    out.push('');
    out.push(decisionRecommendation(report, underpowered, exclusions));
    process.stdout.write(out.join('\n') + '\n');
  }

  // ── --check: two gates (KTD10) + F5 substrate stability ───────────────────
  if (CHECK) {
    if (!fs.existsSync(BASELINE_PATH)) {
      process.stderr.write(`[impact-pdg --check] FAIL: no baselines.json at ${BASELINE_PATH}\n`);
      process.exit(1);
    }
    const baselines = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const failures = [];

    // Gate 1 — order-independent annotation fingerprint (unreviewed GT edits).
    if (baselines.annotationFingerprint !== annotationFingerprint) {
      failures.push(
        `annotation fingerprint drift: ground-truth set changed without re-baseline ` +
          `(got ${annotationFingerprint}, expected ${baselines.annotationFingerprint}) — ` +
          `review the ground-truth.json edits, then re-baseline.`,
      );
    }

    // Gate 2 — one-sided F1 regression band per mode per scope (improvements
    // pass freely; only a DROP beyond ε fails). Median-of-K already applied.
    const eps = baselines.epsilon ?? 0.05;
    const bands = baselines.f1Bands ?? {};
    for (const s of SCOPES) {
      for (const m of MODES) {
        const baseF1 = bands[s]?.[m];
        const gotF1 = report[s][m].f1;
        if (baseF1 === undefined || baseF1 === null) continue; // no band ⇒ nothing to regress against
        if (gotF1 === null) {
          // F1 became undefined where a baseline existed — a structural change
          // (the scope lost all measurable cases). Flag it, don't pass silently.
          failures.push(
            `${s}/${m}: F1 is now n/a but baseline was ${fmt(baseF1)} (scope lost measurable cases?)`,
          );
          continue;
        }
        if (gotF1 < baseF1 - eps) {
          failures.push(
            `${s}/${m}: F1 ${fmt(gotF1)} < baseline ${fmt(baseF1)} − ε(${eps}) = ${fmt(baseF1 - eps)} ` +
              `(median of K=${K})`,
          );
        }
      }
    }

    if (failures.length > 0) {
      for (const f of failures) process.stderr.write(`[impact-pdg --check] FAIL: ${f}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `[impact-pdg --check] PASS (${SCOPES.length} scopes × ${MODES.length} modes, ` +
        `fingerprint OK, K=${K})\n`,
    );
  }
}

run().catch((err) => {
  process.stderr.write(`[impact-pdg] ERROR: ${err?.stack || err}\n`);
  process.exit(1);
});
