import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { repositorySourcePath } from './repository-source.js';

test('packaged Agent instructions expose exactly three default decisions and the five-command workflow', async () => {
  const skill = await readFile(await repositorySourcePath('skills/superppt/SKILL.md'), 'utf8');
  const stages = JSON.parse(await readFile(await repositorySourcePath('skills/superppt/references/阶段契约.json'), 'utf8'));
  assert.deepEqual(stages.defaultDecisions.map((s: {stage: string}) => s.stage), ['plan-review', 'sample-review', 'deck-review']);
  assert.match(skill, /kind: work/);
  assert.match(skill, /风格只能单选/);
  assert.doesNotMatch(skill, /admit-image-call|approve-impact|authenticated|strict mode|迁移原子/);
  const help = await readFile(await repositorySourcePath('src/cli.ts'), 'utf8');
  assert.match(help, /\['start', 'continue', 'decide', 'edit', 'status'\]/);
});
