import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readyDeck } from './helpers/fast-flow.js';
import { readTask, atomicWrite } from '../src/project/task-store.js';
import { spliceTaskSlide } from '../src/deck-revisions/task-splice.js';

test('splicing rejects real size or aspect changes and malformed dimensions without writing the candidate', async () => {
  const { root } = await readyDeck();
  const candidate = join(root, (await readTask(root)).currentDeck!.relativePath);
  const original = await readFile(candidate), donorPath = join(root, 'wrong-size.pptx');
  for (const size of [
    '<p:sldSz cx="9144000" cy="6858000"/>', // 4:3
    '<p:sldSz cx="12190780" cy="6857314"/>', // same ratio, real scale change
    '<p:sldSz cx="12192914" cy="6857086"/>', // near axes, aspect skew
    '<p:sldSz cx="0" cy="6858000"/>',
    '<p:sldSz cx="NaN" cy="6858000"/>',
    '<p:sldSz cx="12192000"/>',
    '',
  ]) {
    const donor = await JSZip.loadAsync(original);
    donor.file('ppt/presentation.xml', (await donor.file('ppt/presentation.xml')!.async('string')).replace(/<p:sldSz\b[^>]*\/>/, size));
    await atomicWrite(donorPath, await donor.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(spliceTaskSlide(candidate, 'ppt/slides/slide2.xml', donorPath), /dimensions/);
    assert.deepEqual(await readFile(candidate), original);
  }
});
