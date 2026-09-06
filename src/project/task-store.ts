import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TaskStateSchema, type TaskState } from './task-schema.js';

export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const locks = new AsyncLocalStorage<string>();
const transactions = new AsyncLocalStorage<{ root: string; state: TaskState }>();
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export async function taskPath(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Path must stay inside the task');
  const base = await realpath(root), target = resolve(base, path);
  if (!relative(base, target) || relative(base, target).startsWith('..' + sep)) throw new Error('Invalid task artifact path');
  let cursor = base;
  for (const part of relative(base, target).split(sep)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Linked task artifacts are not supported'); }
    catch (e) { if (!missing(e)) throw e; }
  }
  return target;
}

export async function atomicWrite(path: string, bytes: string | Buffer, operations: { beforeRename?: () => void } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { operations.beforeRename?.(); await rename(temporary, path); }
  catch (e) { await unlink(temporary).catch(() => {}); throw e; }
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export async function writeTaskJson(root: string, path: string, value: unknown): Promise<void> {
  await atomicWrite(await taskPath(root, path), json(value));
}
export async function readTaskJson(root: string, path: string): Promise<unknown> {
  return JSON.parse((await readArtifact(root, path)).toString('utf8'));
}
export async function readArtifact(root: string, path: string, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  const full = await taskPath(root, path), stat = await lstat(full);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Artifact must be a bounded regular file');
  const bytes = await readFile(full);
  if (bytes.length > maxBytes) throw new Error('Artifact too large');
  return bytes;
}

export async function withTaskLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  root = await realpath(root);
  if (locks.getStore() === root) return action();
  const path = join(root, '.task.lock');
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(path, 'wx', 0o600); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) {
        if (Date.now() - (await lstat(path)).mtimeMs < 30000) throw new Error('Task lock is being initialized; retry');
        await unlink(path); // An initialization interrupted before its PID was written.
        continue;
      }
      try { process.kill(pid, 0); throw new Error('Task is busy; retry after the current local operation'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      await unlink(path);
    }
  }
  if (!handle) throw new Error('Task is busy');
  try { await handle.writeFile(String(process.pid)); return await locks.run(root, action); }
  finally { await handle.close(); await unlink(path); }
}

export async function readTask(root: string): Promise<TaskState> {
  const transaction = transactions.getStore();
  if (transaction?.root === await realpath(root)) return structuredClone(transaction.state);
  let raw;
  try { raw = await readTaskJson(root, 'superppt.json'); } catch (e) { if (!missing(e)) throw e; }
  const result = TaskStateSchema.safeParse(raw);
  if (!result.success) throw new Error('Unsupported project. 请使用新的空目录。');
  return result.data;
}
export async function updateTask(root: string, change: (s: TaskState) => TaskState, ops: { beforeRename?: () => void } = {}): Promise<TaskState> {
  return withTaskLock(root, async () => {
    const before = await readTask(root), after = TaskStateSchema.parse(change(before));
    if (after.projectId !== before.projectId) throw new Error('Project ID cannot change');
    const transaction = transactions.getStore();
    if (transaction?.root === await realpath(root)) {
      transaction.state = after;
      return after;
    }
    await atomicWrite(await taskPath(root, 'superppt.json'), json(after), ops);
    await writeTaskJson(root, 'output/current.json', after.currentDeck);
    return after;
  });
}
// Commit workflow state and its retry receipt together, once per local command.
// Artifacts are prepared before this single authoritative manifest switch.
export async function taskTransaction<T>(root: string, action: () => Promise<T>): Promise<T> {
  root = await realpath(root);
  if (transactions.getStore()?.root === root) return action();
  return withTaskLock(root, async () => {
    const context = { root, state: await readTask(root) };
    const result = await transactions.run(context, action);
    await atomicWrite(await taskPath(root, 'superppt.json'), json(context.state));
    await writeTaskJson(root, 'output/current.json', context.state.currentDeck);
    return result;
  });
}
export async function initializeTask(root: string, title: string): Promise<TaskState> {
  await mkdir(root, { recursive: true });
  return withTaskLock(root, async () => {
    const entries = (await readdir(root)).filter(name => name !== '.task.lock');
    if (entries.length) {
      const s = await readTask(root);
      await writeTaskJson(root, 'output/current.json', s.currentDeck);
      return s;
    }
    const state = TaskStateSchema.parse({
      schemaVersion: 'superppt-task-vnext', projectId: randomUUID(), title,
      contentRevision: randomUUID(), stage: 'planning', sourcePath: 'source/original.md',
      planPath: null, styleLockPath: null, activeJobId: null, currentDeck: null,
      pendingDecision: null, editSessionPath: null, delivery: null, work: null,
      lastResult: null, lastDecision: null, dependenciesPath: null,
    });
    await writeTaskJson(root, 'superppt.json', state);
    await writeTaskJson(root, '.superppt-project.json', { app: 'superppt', schemaVersion: state.schemaVersion, projectId: state.projectId });
    return state;
  });
}
