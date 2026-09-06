import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, realpath, symlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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
