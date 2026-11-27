import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('known advisories fail the release audit even when their parser is unused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = resolve('scripts/audit-dependencies.mjs');
  const clock = join(root, 'clock.mjs'), npm = join(root, 'npm.cjs');
  const distribution = join(root, 'node_modules/pptxgenjs/dist');
  await mkdir(distribution, { recursive: true });
  await writeFile(npm, 'process.stdout.write(JSON.stringify(JSON.parse(process.env.AUDIT_FIXTURE))); process.exit(1);');
  await writeFile(clock, "const RealDate = Date; globalThis.Date = class extends RealDate { constructor(value) { super(value ?? process.env.AUDIT_DATE); } };");
  const baseline = {
    vulnerabilities: {
      'image-size': { via: [
        { source: 1239766, url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr', severity: 'high' },
        { source: 1239765, url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq', severity: 'high' },
      ] },
      pptxgenjs: { via: ['image-size'] },
    },
    metadata: { vulnerabilities: { total: 2 } },
  };
  const cases = [
    { name: 'renumbered advisories' },
    { name: 'unknown advisory', mutate: (r: typeof baseline) => { r.vulnerabilities['image-size'].via[0].url = 'https://github.com/advisories/GHSA-unknown'; } },
    { name: 'reachable parser', code: "require('image-size')" },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const report = structuredClone(baseline);
    scenario.mutate?.(report);
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/pptxgenjs': { version: '4.0.1' },
      'node_modules/image-size': { version: '1.2.1' },
    } }));
    await writeFile(join(distribution, 'pptxgen.js'), scenario.code ?? '// parser is unused');
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(clock).href, script], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, npm_execpath: npm, AUDIT_FIXTURE: JSON.stringify(report), AUDIT_DATE: '2026-09-26T00:00:00Z' },
    });
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stderr, /vulnerabilities/);
  });
});

test('a clean dependency audit is not blocked by an expired exception deadline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-audit-clean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = resolve('scripts/audit-dependencies.mjs');
  const npm = join(root, 'npm.cjs'), clock = join(root, 'clock.mjs');
  await writeFile(npm, 'process.stdout.write(JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } })); process.exit(0);');
  await writeFile(clock, "const RealDate = Date; globalThis.Date = class extends RealDate { constructor(value) { super(value ?? '2027-02-01T00:00:00Z'); } };");
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(clock).href, script], {
    cwd: root, encoding: 'utf8', env: { ...process.env, npm_execpath: npm },
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /no known vulnerabilities/);
});
