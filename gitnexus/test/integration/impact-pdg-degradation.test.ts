/**
 * Integration Tests: `impact` PDG-mode layer degradation contract (U2 / KTD7)
 *
 * End-to-end against a REAL LadybugDB, through the full `callTool('impact', …)`
 * dispatch. Exercises the four-state PDG-layer presence/degradation check
 * (`pdgLayerStatus`) wired into `_impactImpl`'s PDG branch — the check that
 * fires BEFORE symbol resolution / traversal so a missing or partial `--pdg`
 * layer returns a distinct guidance note instead of a confusing empty blast
 * radius (or the U2-era `_runImpactPDG` "not yet implemented" stub error).
 *
 * The four states (KTD7) are driven by what the (mocked) `loadMeta` returns —
 * matching the seeded-DB reality that there is no on-disk `meta.json`:
 *   - no-layer          : meta readable, no `pdg` stamp        → run analyze --pdg
 *   - sub-layer-missing : exactly one cap stamped (CDG xor RD) → names the missing one
 *   - ready             : both caps stamped                    → falls through to the stub
 *   - unknown           : meta unreadable (null)               → inconclusive, via 1 LIMIT 1 probe
 *
 * The `_runImpactPDG` traversal is still a stub in U2, so the `ready` case
 * asserts the layer check let it THROUGH (the stub's "not yet implemented"
 * sentinel), proving the check is ordered before the stub for the degraded
 * states and falls through only when the layer is complete.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // Default: meta unreadable (the seeded-DB reality — no on-disk meta.json).
    // Individual tests override per state via mockResolvedValueOnce.
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

// Minimal seed: one Function symbol (so a `ready` index could resolve it) plus
// a single BasicBlock + CDG edge so the `unknown` state's LIMIT 1 probe finds a
// row (it must STILL stay inconclusive — a present edge cannot disprove an
// edge-free layer / #2188).
const SEED = [
  `CREATE (fn:Function {id: 'func:hot', name: 'hot', filePath: 'src/hot.ts', startLine: 1, endLine: 5, isExported: true, content: 'function hot() {}', description: 'degradation fixture'})`,
  `CREATE (b0:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:0', filePath: 'src/hot.ts', startLine: 2, endLine: 2, text: 'if (x)'})`,
  `CREATE (b1:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:1', filePath: 'src/hot.ts', startLine: 3, endLine: 3, text: 'doThing();'})`,
];
const SEED_EDGE = `MATCH (a:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:0'}), (b:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:1'})
  CREATE (a)-[:CodeRelation {type: 'CDG', confidence: 1.0, reason: 'T', step: 0}]->(b)`;

const META = (pdg?: RepoMeta['pdg']): RepoMeta => ({ pdg } as unknown as RepoMeta);

withTestLbugDB(
  'impact-pdg-degradation',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
      backend = ext._backend;
    });

    // Reset the loadMeta mock to the default (unreadable) before each test so a
    // mockResolvedValueOnce set in one test never leaks into the next.
    beforeEach(() => {
      vi.mocked(loadMeta).mockReset();
      vi.mocked(loadMeta).mockResolvedValue(null);
    });

    describe('no-layer (meta readable, no pdg stamp)', () => {
      it('returns the definitive "run analyze --pdg" note — and does NOT scan the DB', async () => {
        // Readable meta with no `pdg` key ⇒ the layer was never recorded.
        vi.mocked(loadMeta).mockResolvedValueOnce(META(undefined));
        const spy = vi.spyOn(poolAdapter, 'executeParameterized');
        spy.mockClear();

        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });

        // Definitive, meta-derived: no DB probe ran, so executeParameterized was
        // never called between the spy clear and here (the no-layer branch
        // returns before the probe AND before resolveSymbolCandidates).
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();

        expect(result.mode).toBe('pdg');
        expect(result.pdgLayer).toBe('no-layer');
        expect(result.note).toMatch(/no PDG layer/i);
        expect(result.note).toContain('--pdg');
        // Not the stub, not a status-unknown note, not a confident LOW.
        expect(result.error).toBeUndefined();
        expect(result.note).not.toMatch(/status unknown/i);
        expect(result.note).not.toMatch(/not yet implemented/i);
        expect(result.risk).toBe('UNKNOWN');
        expect(result.impactedCount).toBe(0);
      });
    });

    describe('sub-layer-missing (exactly one cap stamped)', () => {
      it('CDG present, RD absent → names REACHING_DEF as missing', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce(META({ maxCdgEdgesPerFunction: 0 } as any));
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.pdgLayer).toBe('sub-layer-missing');
        expect(result.missingSubLayer).toBe('REACHING_DEF');
        expect(result.note).toMatch(/REACHING_DEF/);
        // Partial layer must NOT be reported as complete (not the stub, no LOW).
        expect(result.note).not.toMatch(/not yet implemented/i);
        expect(result.risk).toBe('UNKNOWN');
      });

      it('RD present, CDG absent → names CDG as missing', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce(
          META({ maxReachingDefEdgesPerFunction: 0 } as any),
        );
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.pdgLayer).toBe('sub-layer-missing');
        expect(result.missingSubLayer).toBe('CDG');
        expect(result.note).toMatch(/\bCDG\b/);
        expect(result.note).not.toMatch(/not yet implemented/i);
        expect(result.risk).toBe('UNKNOWN');
      });
    });

    describe('ready (both caps stamped)', () => {
      it('falls THROUGH the layer check to the traversal (the U2 _runImpactPDG stub)', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce(
          META({ maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 } as any),
        );
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        // The layer is complete, so the check did NOT short-circuit: there is no
        // degradation note / pdgLayer marker — the call reached the stub instead.
        expect(result.pdgLayer).toBeUndefined();
        // U2: the traversal is still the stub. Once U3/U4 land this assertion
        // updates to a real blast radius; the load-bearing fact for U2 is that
        // `ready` did NOT return a degradation note.
        expect(result.mode).toBe('pdg');
        expect(result.error).toMatch(/not yet implemented/i);
      });
    });

    describe('unknown (meta unreadable)', () => {
      it('returns the inconclusive "status unknown" note via a bounded probe, even with edges present', async () => {
        // loadMeta defaults to null (unreadable) via beforeEach. The seeded DB
        // DOES carry a CDG edge, but the note must stay inconclusive — a present
        // edge cannot prove the layer is complete, and a missing one is
        // indistinguishable from an edge-free index (#2188).
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.pdgLayer).toBe('unknown');
        expect(result.note).toMatch(/status unknown/i);
        expect(result.note).toContain('--pdg');
        // Inconclusive ≠ definitive no-layer wording.
        expect(result.note).not.toMatch(/no PDG layer/i);
        expect(result.note).not.toMatch(/not yet implemented/i);
        expect(result.risk).toBe('UNKNOWN');
        expect(result.impactedCount).toBe(0);
      });
    });

    describe('callgraph mode is unaffected by the PDG-layer probe', () => {
      it('mode:callgraph never consults the PDG layer (no degradation note)', async () => {
        // Even with meta unreadable, a callgraph impact resolves the symbol and
        // returns a real (here: empty-graph) blast radius, never a PDG note.
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'callgraph',
        });
        expect(result.pdgLayer).toBeUndefined();
        // The callgraph path never sets a PDG degradation note. (It may carry
        // its own callgraph-flavored notes, but never the PDG-layer wording.)
        const note = typeof result.note === 'string' ? result.note : '';
        expect(note).not.toMatch(/status unknown/i);
        expect(note).not.toMatch(/no PDG layer/i);
      });
    });
  },
  {
    seed: [...SEED, SEED_EDGE],
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'degradation-repo',
          path: '/degradation/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'deg123',
          stats: { files: 1, nodes: 3, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
