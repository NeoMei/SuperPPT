import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTaskLock } from '../src/project/task-store.js';

test('concurrent stale lock recovery never admits two processes at once', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-lock-race-'));
  const events = join(root, 'events');
  const ready = join(root, 'ready');
  const release = join(root, 'release');
  const deadPid = 2147483647;
  await writeFile(join(root, '.task.lock'), String(deadPid));
  const modulePath = new URL('../src/project/task-store.js', import.meta.url).href;
  const script = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const [root, events, ready, release, modulePath, role, deadPid] = process.argv.slice(1);
    const actualKill = process.kill;
    if (role === 'slow') process.kill = (pid, signal) => {
      if (pid === Number(deadPid)) {
        writeFileSync(ready, 'observed');
        const until = Date.now() + 10000;
        while (!existsSync(release) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        if (!existsSync(release)) throw new Error('race coordination timed out');
        throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
      }
      return actualKill(pid, signal);
    };
    const { withTaskLock } = await import(modulePath);
    try {
      await withTaskLock(root, async () => {
        appendFileSync(events, role + ':enter\\n');
        if (role === 'fast') writeFileSync(release, 'entered');
        await new Promise(resolve => setTimeout(resolve, role === 'fast' ? 1800 : 300));
        appendFileSync(events, role + ':exit\\n');
      });
    } catch (e) {
      appendFileSync(events, role + ':busy\\n');
      if (role === 'fast') writeFileSync(release, 'busy');
    }
  `;
  const start = (role: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, events, ready, release, modulePath, role, String(deadPid)], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    return new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
    });
  };
  const slow = start('slow');
  for (let n = 0; n < 300; n++) {
    if (await readFile(ready).then(() => true, () => false)) break;
    if (n === 299) throw new Error('slow process did not reach stale-lock inspection');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await Promise.all([slow, start('fast')]);
  const lines = (await readFile(events, 'utf8')).trim().split('\n');
  let inside = 0;
  for (const line of lines) {
    if (line.endsWith(':enter')) assert.equal(++inside, 1, `overlapping critical sections: ${lines.join(', ')}`);
    if (line.endsWith(':exit')) inside--;
  }
  assert.equal(inside, 0);
  assert.ok(lines.some(line => line.endsWith(':enter')));
});

test('an abandoned recovery guard fails closed rather than deleting a task lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-recovery-guard-'));
  const lock = join(root, '.task.lock');
  await writeFile(lock, '2147483647');
  await writeFile(join(root, '.task.lock.recovery'), 'abandoned');
  await assert.rejects(withTaskLock(root, async () => {}), /recovery/i);
  assert.equal(await readFile(lock, 'utf8'), '2147483647');
});

test('an abandoned recovery guard prevents acquisition even when the task lock is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-missing-lock-'));
  await writeFile(join(root, '.task.lock.recovery'), 'abandoned');
  await assert.rejects(withTaskLock(root, async () => {}), /recovery/i);
  await assert.rejects(readFile(join(root, '.task.lock')), { code: 'ENOENT' });
});

test('a recovery inspection cannot remove a replacement lock after its old owner exits', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'superppt-owner-recovery-'));
  const modulePath = new URL('../src/project/task-store.js', import.meta.url).href;
  const script = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [root,modulePath,role] = process.argv.slice(1);
    const path = name => join(root,name);
    const wait = async name => { for (let n=0;n<600;n++) { if (existsSync(path(name))) return; await new Promise(r=>setTimeout(r,10)); } throw Error('timeout '+name); };
    if (role === 'recover') {
      const kill = process.kill;
      process.kill = (pid,signal) => {
        writeFileSync(path('observed'),'1');
        const until=Date.now()+7000;
        while (!existsSync(path('recover-go')) && Date.now()<until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        return kill(pid,signal);
      };
    }
    const {withTaskLock} = await import(modulePath);
    try {
      await withTaskLock(root,async()=>{
        appendFileSync(path('events'),role+':enter\\n');
        writeFileSync(path(role+'-ready'),'1');
        await wait(role+'-release');
        appendFileSync(path('events'),role+':exit\\n');
      });
    } catch (e) { appendFileSync(path('events'),role+':error\\n'); }
    writeFileSync(path(role+'-done'),'1');
  `;
  const start = (role: string) => {
    const child = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',script,root,modulePath,role], {cwd:process.cwd(),stdio:['ignore','ignore','pipe']});
    let stderr = ''; child.stderr.on('data', c => stderr += c);
    return new Promise<void>((resolve,reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${role} exited ${code}: ${stderr}`))); });
  };
  const has = (name: string) => readFile(join(root,name)).then(() => true, () => false);
  const wait = async (name: string) => { for(let n=0;n<400;n++){ if(await has(name)) return; await new Promise(r=>setTimeout(r,10)); } throw Error(`timeout ${name}`); };
  const owner = start('owner'); await wait('owner-ready');
  const recover = start('recover'); await wait('observed');
  await writeFile(join(root,'owner-release'),'1');
  // Old code releases immediately; the corrected code blocks until inspection ends.
  for (let n=0;n<60 && !await has('owner-done');n++) await new Promise(r=>setTimeout(r,10));
  const next = start('new');
  for (let n=0;n<60 && !await has('new-ready') && !await has('new-done');n++) await new Promise(r=>setTimeout(r,10));
  await writeFile(join(root,'recover-go'),'1');
  for (let n=0;n<150 && !await has('recover-ready') && !await has('recover-done');n++) await new Promise(r=>setTimeout(r,10));
  await writeFile(join(root,'recover-release'),'1');
  await writeFile(join(root,'new-release'),'1');
  await Promise.all([owner,recover,next]);
  const lines=(await readFile(join(root,'events'),'utf8')).trim().split('\n');
  let inside=0;
  for (const line of lines) {
    if (line.endsWith(':enter')) assert.equal(++inside,1,`overlapping critical sections: ${lines.join(', ')}`);
    if (line.endsWith(':exit')) inside--;
  }
  assert.equal(inside,0);
});
