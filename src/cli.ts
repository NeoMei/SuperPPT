import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { initializeTask, readTask, updateTask, writeTaskJson, atomicWrite, taskPath, hash, readArtifact, missing } from './project/task-store.js';
import { resolveTaskDependencies } from './dependencies/task-dependencies.js';
import { continueTask, taskReply } from './workflow/continue.js';
import { decideTask } from './workflow/decide.js';
import { EditRequestSchema } from './workflow/contracts.js';
import { editTask } from './deck-revisions/task-deck.js';

export const COMMANDS = ['start', 'continue', 'decide', 'edit', 'status'] as const;
const usage = `SuperPPT — three decisions: plan, sample, complete deck
start --project <new-root> --input <source.json> --dependencies <resolved-roots.json>
continue --project <root> [--result <work-result.json>]
decide --project <root> --input <decision.json>
edit --project <root> --input <edit-request.json>
status --project <root>
Source: {title, text} or {title, markdownPath}. Dependencies: {aiSkillRoot, editableSkillRoot}.
Work results: {workId, contentRevision, payload}. Read the returned inputPath for the task.
Decision actions and edit routes are documented in skills/superppt/references/依赖说明.md.`;
const jsonInput = async (path: string) => { const bytes = await readFile(path); if (bytes.length > 16 * 1024 * 1024) throw new Error('Input is too large'); return JSON.parse(bytes.toString('utf8')); };

async function main(args: string[]) {
  if (args.includes('--help')) { process.stdout.write(usage + '\n'); return; }
  const [command, ...rest] = args;
  if (!COMMANDS.includes(command as typeof COMMANDS[number])) throw new Error(usage);
  const allowed = command === 'start' ? ['--project', '--input', '--dependencies'] : command === 'continue' ? ['--project', '--result'] : command === 'status' ? ['--project'] : ['--project', '--input'];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1] || options.has(rest[i])) throw new Error('Unknown, missing or duplicate option');
    options.set(rest[i], rest[i + 1]);
  }
  const required = (key: string) => { const v = options.get(key); if (!v) throw new Error(`Missing ${key}`); return v; };
  const root = resolve(required('--project'));
  let result;
  if (command === 'start') {
    const source = z.object({ title: z.string().min(1), text: z.string().optional(), markdownPath: z.string().optional() }).strict().parse(await jsonInput(required('--input')));
    if ((source.text === undefined) === (source.markdownPath === undefined)) throw new Error('Provide text or markdownPath, exactly one');
    const rawDeps = z.object({ aiSkillRoot: z.string(), editableSkillRoot: z.string() }).strict().parse(await jsonInput(required('--dependencies')));
    const deps = await resolveTaskDependencies(rawDeps);
    const bytes = source.markdownPath ? await readFile(source.markdownPath) : Buffer.from(source.text!);
    if (bytes.length > 16 * 1024 * 1024) throw new Error('Source too large');
    const s = await initializeTask(root, source.title);
    try { if (hash(await readArtifact(root, s.sourcePath)) !== hash(bytes)) throw new Error('Task source already exists with different content'); }
    catch (e) { if (!missing(e)) throw e; await atomicWrite(await taskPath(root, s.sourcePath), bytes); }
    await writeTaskJson(root, 'dependencies.json', deps);
    await updateTask(root, old => ({ ...old, dependenciesPath: 'dependencies.json' }));
    result = await continueTask(root);
  } else if (command === 'continue') result = await continueTask(root, options.get('--result'));
  else if (command === 'decide') result = await decideTask(root, await jsonInput(required('--input')));
  else if (command === 'edit') result = await editTask(root, EditRequestSchema.parse(await jsonInput(required('--input'))));
  else result = { task: await readTask(root), next: await taskReply(root) };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Task failed' }) + '\n');
  process.exitCode = 1;
});
