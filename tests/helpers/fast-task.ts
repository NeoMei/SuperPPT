import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initializeTask, updateTask, writeTaskJson, hash } from '../../src/project/task-store.js';
import { resolveTaskDependencies } from '../../src/dependencies/task-dependencies.js';
import { PlanBundleSchema } from '../../src/workflow/contracts.js';

export async function fixturePlan(n = 3) {
  const catalog = JSON.parse(await readFile(join(process.cwd(), 'skills/superppt/assets/styles/catalog.json'), 'utf8'));
  const ids = Array.from({ length: n }, () => randomUUID());
  return PlanBundleSchema.parse({
    brief: { schemaVersion: 1, title: '效率测试', purpose: '解释任务', audience: '用户', language: 'zh-CN', targetSlides: n, mustCover: ['测试'], constraints: [] },
    outline: { schemaVersion: 1, slides: ids.map((id, order) => ({ id, order, title: `第${order + 1}页`, role: 'content', purpose: '解释', sourceRefs: ['source/original.md'] })) },
    slides: ids.map(slideId => ({ schemaVersion: 1, slideId, title: '标题', role: 'content', coreMessage: '清晰', requiredText: ['标题'], visualSubject: '结构图', composition: '左文右图', relationships: ['上下关系'], forbidden: ['水印'], sourceRefs: ['source/original.md'] })),
    styles: catalog.styles.slice(0, 3), representativeSlideId: ids[0],
  });
}
export async function fixtureTask() {
  const container = await mkdtemp(join(tmpdir(), 'superppt-fast-'));
  const root = join(container, 'task');
  await initializeTask(root, '效率测试');
  const ai = join(container, 'ai'), editable = join(container, 'editable');
  for (const [base, files] of [[ai, ['SKILL.md', 'references/capabilities.json', 'scripts/generation_result.py', 'scripts/gen_slide.py', 'scripts/export_images.py', 'scripts/host_routing_policy.py', 'scripts/import_host_image.py', 'scripts/prepare_editable_input.py']], [editable, ['.codex-plugin/plugin.json', 'skills/image-to-editable-pptx/SKILL.md', 'src/cli.ts']]] as const) {
    for (const file of files) { await mkdir(join(base, file, '..'), { recursive: true }); await writeFile(join(base, file), '{}'); }
  }
  await writeFile(join(ai, 'references/capabilities.json'), JSON.stringify({ schemaVersion: 1, skill: 'ai-image-to-ppt', scripts: { generationResult: 'scripts/generation_result.py', hostRoutingPolicy: 'scripts/host_routing_policy.py', importHostImage: 'scripts/import_host_image.py', prepareEditableInput: 'scripts/prepare_editable_input.py', apiGenerator: 'scripts/gen_slide.py', normalizedExport: 'scripts/export_images.py' } }));
  await writeFile(join(editable, 'package.json'), JSON.stringify({ name: 'image-to-editable-pptx', version: '0.2.2' }));
  await writeTaskJson(root, 'dependencies.json', await resolveTaskDependencies({ aiSkillRoot: ai, editableSkillRoot: editable }));
  await updateTask(root, s => ({ ...s, dependenciesPath: 'dependencies.json' }));
  return { root, ai, editable };
}
export async function fixtureImage(root: string, path: string, width = 160, height = 90) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#eeeedd' } }).png().toBuffer();
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), bytes);
  return { path, sha256: hash(bytes) };
}
