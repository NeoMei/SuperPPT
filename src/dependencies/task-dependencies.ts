import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { hash, readTask, readTaskJson, writeTaskJson, taskPath } from '../project/task-store.js';

const DependencySchema = z.object({ root: z.string(), skill: z.string(), files: z.array(z.string()), fingerprint: z.string(), version: z.string().nullable() });
export const TaskDependenciesSchema = z.object({ ai: DependencySchema, editable: DependencySchema });
export type TaskDependencies = z.infer<typeof TaskDependenciesSchema>;
const StableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
async function fingerprint(files: string[]): Promise<string> {
  return hash(JSON.stringify(await Promise.all(files.map(async path => { const s = await stat(path); if (!s.isFile()) throw new Error('Dependency entry is not a file'); return [path, s.size, s.mtimeMs, hash(await readFile(path))]; }))));
}
export async function resolveTaskDependencies(input: { aiSkillRoot: string; editableSkillRoot: string }): Promise<TaskDependencies> {
  const aiRoot = await realpath(input.aiSkillRoot);
  let editableRoot = await realpath(input.editableSkillRoot);
  if (!(await stat(join(editableRoot, 'package.json')).catch(() => null))) editableRoot = dirname(dirname(editableRoot));
  const pkg = JSON.parse(await readFile(join(editableRoot, 'package.json'), 'utf8'));
  // Version admission is not output compatibility; validate the actual donor on import.
  if (pkg.name !== 'image-to-editable-pptx' || typeof pkg.version !== 'string' || pkg.version.trim() !== pkg.version || !StableVersion.test(pkg.version)) throw new Error('Requires a stable image-to-editable-pptx release; use the latest stable installed plugin, not a prerelease');
  const capability = z.object({ schemaVersion: z.literal(1), skill: z.literal('ai-image-to-ppt'), scripts: z.object({ generationResult: z.string(), hostRoutingPolicy: z.string(), importHostImage: z.string(), prepareEditableInput: z.string(), apiGenerator: z.string(), normalizedExport: z.string() }) }).parse(JSON.parse(await readFile(join(aiRoot, 'references/capabilities.json'), 'utf8')));
  const aiFiles = await Promise.all(['SKILL.md', 'references/capabilities.json', ...Object.values(capability.scripts)].map(p => taskPath(aiRoot, p)));
  const editableFiles = ['package.json', '.codex-plugin/plugin.json', 'skills/image-to-editable-pptx/SKILL.md', 'src/cli.ts'].map(p => join(editableRoot, p));
  return TaskDependenciesSchema.parse({
    ai: { root: aiRoot, skill: aiFiles[0], files: aiFiles, fingerprint: await fingerprint(aiFiles), version: null },
    editable: { root: editableRoot, skill: editableFiles[2], files: editableFiles, fingerprint: await fingerprint(editableFiles), version: pkg.version },
  });
}
export async function checkTaskDependencies(root: string): Promise<TaskDependencies> {
  const task = await readTask(root);
  if (!task.dependenciesPath) throw new Error('Dependencies have not been resolved');
  const deps = TaskDependenciesSchema.parse(await readTaskJson(root, task.dependenciesPath));
  // Entry digests only; never rescan an entire dependency source tree.
  for (const dep of [deps.ai, deps.editable]) {
    if (await fingerprint(dep.files) !== dep.fingerprint) throw new Error('Dependency installation changed; resolve it before creating a new job');
  }
  return deps;
}
export async function preflightJob(root: string, jobId: string): Promise<void> {
  const deps = await checkTaskDependencies(root);
  await writeTaskJson(root, `generation/jobs/${jobId}/preflight.json`, { jobId, fingerprints: [deps.ai.fingerprint, deps.editable.fingerprint] });
}
