import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositorySourcePath } from './repository-source.js';

const run = promisify(execFile);

test('empty source requests invite input before dependency discovery or project creation', async () => {
  const runtime = process.env.SUPERPPT_TEST_ROOT ?? await repositorySourcePath('.');
  const compiled = !process.env.SUPERPPT_TEST_ROOT && import.meta.url.includes('/dist/');
  const cli = join(runtime, compiled ? 'dist/src/cli.js' : 'src/cli.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'superppt-intake-'));
  const source = join(tmp, 'source.json'), markdown = join(tmp, 'empty.md');
  await writeFile(markdown, '\ufeff\n  \t');
  const cases = [
    { title: '主题', text: '' },
    { title: '主题', text: '\ufeff \n\t' },
    { title: '主题', markdownPath: markdown },
    { title: '主题', markdownPath: '   ' },
    { title: '主题' },
    { title: '', text: '实际主题' },
    { title: '  ', text: '实际主题' },
  ];
  for (const [index, input] of cases.entries()) {
    await writeFile(source, JSON.stringify(input));
    const project = join(tmp, `project-${index}`);
    await assert.rejects(run(process.execPath, [...(compiled ? ['--no-experimental-detect-module'] : ['--import', 'tsx']), cli, 'start', '--project', project, '--input', source, '--dependencies', join(tmp, 'missing-dependencies.json')], { cwd: runtime }), (error: any) => {
      assert.match(error.stderr, /请提供.*主题.*资料/);
      return true;
    });
    assert.ok(!(await readdir(tmp)).includes(`project-${index}`));
  }
  assert.equal(await readFile(markdown, 'utf8'), '\ufeff\n  \t');
});


test('a concrete topic reaches dependency validation without requiring a requirements file', async () => {
  const runtime = process.env.SUPERPPT_TEST_ROOT ?? await repositorySourcePath('.');
  const compiled = !process.env.SUPERPPT_TEST_ROOT && import.meta.url.includes('/dist/');
  const cli = join(runtime, compiled ? 'dist/src/cli.js' : 'src/cli.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'superppt-topic-'));
  const source = join(tmp, 'source.json');
  await writeFile(source, JSON.stringify({ title: '项目汇报', text: '围绕 AI 教育应用制作一份项目汇报' }));
  await assert.rejects(run(process.execPath, [...(compiled ? ['--no-experimental-detect-module'] : ['--import', 'tsx']), cli, 'start', '--project', join(tmp, 'project'), '--input', source, '--dependencies', join(tmp, 'missing-dependencies.json')], { cwd: runtime }), (error: any) => {
    assert.match(error.stderr, /missing-dependencies/);
    return true;
  });
  assert.ok(!(await readdir(tmp)).includes('project'));
});
