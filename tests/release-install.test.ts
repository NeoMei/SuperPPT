import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositorySourcePath } from './repository-source.js';

test('packed plugin installs independently and runs complete public CLI workflows', { skip: process.env.SUPERPPT_RELEASE_SMOKE !== '1', timeout: 180000 }, async t => {
  const root = await repositorySourcePath('.'), temporary = await mkdtemp(join(tmpdir(), 'superppt-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const run = promisify(execFile), npm = process.env.npm_execpath;
  assert.ok(npm, 'run via npm run test:release-install');
  const packed = JSON.parse((await run(process.execPath, [npm!, 'pack', '--json', '--pack-destination', temporary], { cwd: root })).stdout);
  await run('tar', ['-xzf', join(temporary, packed[0].filename), '-C', temporary]);
  const installed = join(temporary, 'package');
  const installEnv = { ...process.env };
  // npm exports a user's global allow-scripts setting to lifecycle children,
  // then rejects that environment override for a nested project install.
  delete installEnv.npm_config_allow_scripts;
  // npm tarballs omit package-lock.json; consumers install declared runtime deps.
  await run(process.execPath, [npm!, 'install', '--omit=dev'], { cwd: installed, env: installEnv, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.koffi, undefined);
  const testEnv = { ...process.env, SUPERPPT_TEST_ROOT: installed };
  delete (testEnv as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
  const result = await run(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', join(root, 'tests/fast-cli.test.ts')], { cwd: root, env: testEnv, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(result.stdout, /pass 2/);
});
