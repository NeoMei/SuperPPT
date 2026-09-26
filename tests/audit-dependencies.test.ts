import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('audit exceptions use stable advisory identities while retaining every safety boundary', async (t) => {
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
    { name: 'renumbered same advisories', status: 0 },
    { name: 'unknown advisory', status: 1, mutate: (r: typeof baseline) => { r.vulnerabilities['image-size'].via[0].url = 'https://github.com/advisories/GHSA-unknown'; } },
    { name: 'duplicate allowed advisory', status: 1, mutate: (r: typeof baseline) => { r.vulnerabilities['image-size'].via[0] = r.vulnerabilities['image-size'].via[1]; } },
    { name: 'changed severity', status: 1, mutate: (r: typeof baseline) => { r.vulnerabilities['image-size'].via[0].severity = 'critical'; } },
    { name: 'extra finding', status: 1, mutate: (r: typeof baseline) => { r.metadata.vulnerabilities.total = 3; } },
    { name: 'changed transitive dependency', status: 1, mutate: (r: typeof baseline) => { r.vulnerabilities.pptxgenjs.via = ['other']; } },
    { name: 'changed locked version', status: 1, version: '1.2.2' },
    { name: 'reachable parser', status: 1, code: "require('image-size')" },
    { name: 'expired exception', status: 1, date: '2026-10-03T00:00:00Z' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const report = structuredClone(baseline);
    scenario.mutate?.(report);
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/pptxgenjs': { version: '4.0.1' },
      'node_modules/image-size': { version: scenario.version ?? '1.2.1' },
    } }));
    await writeFile(join(distribution, 'pptxgen.js'), scenario.code ?? '// parser is unused');
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(clock).href, script], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, npm_execpath: npm, AUDIT_FIXTURE: JSON.stringify(report), AUDIT_DATE: scenario.date ?? '2026-09-26T00:00:00Z' },
    });
    assert.equal(child.status, scenario.status, child.stdout + child.stderr);
    if (scenario.status === 0) assert.match(child.stdout, /accepted two unreachable/);
    else if (scenario.date) assert.match(child.stderr, /exception expired/);
    else if (scenario.version || scenario.code) assert.match(child.stderr, /exception is no longer proven unreachable/);
    else assert.deepEqual(JSON.parse(child.stderr), report);
  });
});
