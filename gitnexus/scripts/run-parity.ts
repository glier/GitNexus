/**
 * Consolidated scope-resolution parity runner.
 *
 * Replaces the per-language matrix in ci-scope-parity.yml with a single
 * job that runs all migrated languages sequentially in one process. This
 * eliminates 8× redundant checkout + npm ci + build cycles (the old
 * workflow created a separate GitHub Actions job per language).
 *
 * For each language in MIGRATED_LANGUAGES:
 *   1. Run its resolver test with REGISTRY_PRIMARY_<LANG>=0 (legacy DAG)
 *   2. Run its resolver test with REGISTRY_PRIMARY_<LANG>=1 (registry-primary)
 *
 * Both modes must pass. Failures are collected and reported at the end
 * so all regressions are visible in a single CI run (equivalent to the
 * old workflow's fail-fast: false behavior).
 *
 * Usage:
 *   npx tsx scripts/run-parity.ts
 *   npx tsx scripts/run-parity.ts --language python   # single language
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MIGRATED_LANGUAGES } from '../src/core/ingestion/registry-primary-flag.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

interface ParityResult {
  lang: string;
  mode: 'legacy' | 'registry-primary';
  passed: boolean;
  output: string;
}

function envVarName(slug: string): string {
  return `REGISTRY_PRIMARY_${slug.toUpperCase().replace(/-/g, '_')}`;
}

function testFilePath(slug: string): string {
  return `test/integration/resolvers/${slug}.test.ts`;
}

function runVitest(testFile: string, env: Record<string, string>): { ok: boolean; output: string } {
  try {
    const output = execFileSync('npx', ['vitest', 'run', testFile], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      // TypeScript and C++ resolver tests can take 60-90s on CI runners.
      // 120s per invocation × 18 worst-case = 36 min, but realistic total
      // is ~11 min. The CI job timeout (30 min) is the outer guard.
      timeout: 120 * 1000,
    });
    return { ok: true, output };
  } catch (err: any) {
    const stdout = (err.stdout as string) ?? '';
    const stderr = (err.stderr as string) ?? '';
    const combined = (stdout + '\n' + stderr).trim() || err.message || String(err);
    return { ok: false, output: combined };
  }
}

// Parse CLI args
const args = process.argv.slice(2);
const langFlag = args.indexOf('--language');
const singleLang = langFlag >= 0 ? args[langFlag + 1] : undefined;

if (langFlag >= 0 && singleLang === undefined) {
  console.error('--language requires a value');
  process.exit(1);
}

const languages = singleLang ? [singleLang] : [...MIGRATED_LANGUAGES].map(String);

// Verify test files exist before running
const missingFiles: string[] = [];
for (const lang of languages) {
  const file = path.resolve(ROOT, testFilePath(lang));
  try {
    fs.accessSync(file);
  } catch {
    missingFiles.push(`${testFilePath(lang)} (${lang})`);
  }
}

if (missingFiles.length > 0) {
  console.error('Missing resolver test files:');
  for (const f of missingFiles) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`Scope-resolution parity: ${languages.length} language(s)`);
console.log(`Languages: ${languages.join(', ')}\n`);

const results: ParityResult[] = [];

for (const lang of languages) {
  const file = testFilePath(lang);
  const envVar = envVarName(lang);

  // Legacy DAG mode
  console.log(`── ${lang} — legacy DAG (${envVar}=0) ──`);
  const legacy = runVitest(file, { [envVar]: '0' });
  results.push({ lang, mode: 'legacy', passed: legacy.ok, output: legacy.output });
  console.log(legacy.ok ? '  ✓ PASSED' : '  ✗ FAILED');

  // Registry-primary mode
  console.log(`── ${lang} — registry-primary (${envVar}=1) ──`);
  const registry = runVitest(file, { [envVar]: '1' });
  results.push({ lang, mode: 'registry-primary', passed: registry.ok, output: registry.output });
  console.log(registry.ok ? '  ✓ PASSED' : '  ✗ FAILED');

  console.log();
}

// Summary
console.log('═══════════════════════════════════════');
console.log('PARITY SUMMARY');
console.log('═══════════════════════════════════════');

const failures = results.filter((r) => !r.passed);
const passes = results.filter((r) => r.passed);

console.log(`Passed: ${passes.length}/${results.length}`);

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) {
    console.log(`  ✗ ${f.lang} [${f.mode}]`);
    const lastLines = f.output.split('\n').slice(-10).join('\n');
    console.log(`    ${lastLines.replace(/\n/g, '\n    ')}`);
  }
  process.exit(1);
}

console.log('\nAll parity checks passed.');
