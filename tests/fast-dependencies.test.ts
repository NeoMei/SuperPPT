import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureTask } from './helpers/fast-task.js';
import { resolveTaskDependencies, preflightJob } from '../src/dependencies/task-dependencies.js';
import { randomUUID } from 'node:crypto';

test('dependency cache follows installed skill roots and ignores unrelated source files', async () => {
  const { root, ai, editable } = await fixtureTask();
  const baseline = await resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: join(editable, 'skills/image-to-editable-pptx') });
  assert.equal(baseline.editable.root, await realpath(editable));
  await writeFile(join(editable, 'src/unrelated.ts'), 'unrelated');
  await preflightJob(root, randomUUID());
  assert.deepEqual(await resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable }), baseline);
  await writeFile(join(ai, 'scripts/import_host_image.py'), 'changed');
  await assert.rejects(() => preflightJob(root, randomUUID()), /installation changed/);
});

test('a different capability package cannot masquerade as the image dependency', async () => {
  const { ai, editable } = await fixtureTask();
  await writeFile(join(ai, 'references/capabilities.json'), JSON.stringify({ schemaVersion: 1, skill: 'another-skill', scripts: {} }));
  await assert.rejects(() => resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable }));
});

test('stable converter releases are admitted without a minor-version ceiling and retain their exact version', async () => {
  const { ai, editable } = await fixtureTask();
  for (const version of ['0.2.2', '0.3.0', '0.4.1', '1.0.0', '1.0.0+build.007']) {
    await writeFile(join(editable, 'package.json'), JSON.stringify({ name: 'image-to-editable-pptx', version }));
    const deps = await resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable });
    assert.equal(deps.editable.version, version);
    assert.equal(deps.editable.root, await realpath(editable));
  }
});

test('latest-stable admission still rejects prereleases, malformed versions, wrong identity and missing entries', async () => {
  const { ai, editable } = await fixtureTask();
  for (const version of ['0.3.0-rc.1', '1.0.0-beta+build.1', 'latest', 'v0.3.0', '0.3', '00.3.0', '0.03.0', '0.3.00', '0.3.0+', '0.3.0+bad..id', '0.3.0\n', 3, null]) {
    await writeFile(join(editable, 'package.json'), JSON.stringify({ name: 'image-to-editable-pptx', version }));
    await assert.rejects(() => resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable }), /stable.*image-to-editable-pptx/i, String(version));
  }
  await writeFile(join(editable, 'package.json'), JSON.stringify({ name: 'another-plugin', version: '0.3.0' }));
  await assert.rejects(() => resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable }), /image-to-editable-pptx/);
  await writeFile(join(editable, 'package.json'), JSON.stringify({ name: 'image-to-editable-pptx', version: '0.3.0' }));
  await rm(join(editable, 'src/cli.ts'));
  await assert.rejects(() => resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable }), /ENOENT/);
});
