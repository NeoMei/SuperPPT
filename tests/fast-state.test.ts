import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeTask, readTask, updateTask } from '../src/project/task-store.js';

test('new task resumes and one manifest owns the current state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-fast-state-'));
  const initial = await initializeTask(root, '测试');
  assert.equal((await initializeTask(root, '测试')).projectId, initial.projectId);
  await updateTask(root, s => ({ ...s, title: '已修改' }));
  assert.equal((await readTask(root)).title, '已修改');
});
test('an interrupted empty lock is recoverable after its initialization grace period', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-empty-lock-'));
  const initial = await initializeTask(root, '继续');
  const lock = join(root, '.task.lock');
  await writeFile(lock, '');
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  assert.equal((await initializeTask(root, '继续')).projectId, initial.projectId);
});

test('old or occupied directory is rejected without modifying its files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-fast-old-'));
  const old = '{"schemaVersion":1,"title":"旧稿"}';
  await writeFile(join(root, 'superppt.json'), old);
  await assert.rejects(initializeTask(root, '新稿'), /新的空目录/);
  assert.equal(await readFile(join(root, 'superppt.json'), 'utf8'), old);
});

test('failed state publication leaves old JSON readable; derived pointer is repairable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-fast-crash-'));
  await initializeTask(root, '原稿');
  await assert.rejects(updateTask(root, s => ({ ...s, title: '新稿' }), {
    beforeRename: () => { throw new Error('simulated crash'); },
  }), /simulated crash/);
  assert.equal((await readTask(root)).title, '原稿');
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(join(root, 'output/current.json'), '{"stale":true}');
  await initializeTask(root, '原稿');
  assert.equal(JSON.parse(await readFile(join(root, 'output/current.json'), 'utf8')), null);
});
