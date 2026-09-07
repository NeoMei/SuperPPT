import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositorySourcePath } from './repository-source.js';

const run = promisify(execFile);

test('repository contract scans unfinished markers in text files without interpreting binary assets as text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.codex-plugin'), { recursive: true });
  await mkdir(join(root, 'skills/superppt/assets'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'superppt', version: '0.0.0', engines: { node: '>=22.6' } }));
  await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'superppt', version: '0.0.0', interface: { displayName: 'SuperPPT' } }));
  await writeFile(join(root, 'skills/superppt/SKILL.md'), '---\nname: superppt\n---\n# SuperPPT\n风格只能单选\n');
  await writeFile(join(root, 'skills/superppt/assets/reference.jpg'), Buffer.from([0xff, 0xd8, 0x00, ...Buffer.from('TBD'), 0x00, 0xff, 0xd9]));
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  await writeFile(join(root, 'SECURITY.md'), '# Fixture\n');
  const verifier = await repositorySourcePath('scripts/verify-contract.mjs');

  await run(process.execPath, [verifier], { cwd: root });

  await writeFile(join(root, 'src/unfinished.py'), '# TBD\n');
  await assert.rejects(
    run(process.execPath, [verifier], { cwd: root }),
    (error: any) => error.code === 1 && /unfinished placeholders found in src\/unfinished\.py/.test(error.stderr),
  );
});
