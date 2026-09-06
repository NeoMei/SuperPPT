import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readyDeck, submitWork, generateFixture } from './helpers/fast-flow.js';
import { readTask, readTaskJson, writeTaskJson, atomicWrite, hash } from '../src/project/task-store.js';
import { readBatchJob, readBatchCheckpoint } from '../src/generation/task-batch.js';
import { editTask, readTaskSession, readTaskRevision, presentTaskEdit } from '../src/deck-revisions/task-deck.js';
import { decideTask } from '../src/workflow/decide.js';
import { createPresentation } from '../src/deck/pptx.js';

test('manual reorder/insert/delete adoption preserves saved bytes and the next edit starts from that exact deck', async () => {
  const { root } = await readyDeck(), old = (await readTask(root)).currentDeck!;
  const parent = await readTaskRevision(root, old.revisionId);
  await editTask(root, { pageNumber: 2, mode: 'manual', route: 'direct-edit', instruction: '' });
  const session = await readTaskSession(root), path = join(root, session.candidatePath), zip = await JSZip.loadAsync(await readFile(path));
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const ids = presentation.match(/<p:sldId\b[^>]*\/>/g)!;
  zip.file('ppt/presentation.xml', presentation.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${ids[2]}<p:sldId id="999" r:id="rIdInserted"/>${ids[0]}</p:sldIdLst>`));
  const rel = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  zip.file('ppt/_rels/presentation.xml.rels', rel.replace('</Relationships>', '<Relationship Id="rIdInserted" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide4.xml"/></Relationships>'));
  zip.file('ppt/slides/slide4.xml', (await zip.file('ppt/slides/slide2.xml')!.async('string')).replace(/<[^<>]*creationId\b[^>]*\/>/g, ''));
  zip.file('ppt/slides/_rels/slide4.xml.rels', await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/ppt/slides/slide4.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'));
  const saved = await zip.generateAsync({ type: 'nodebuffer' }); await atomicWrite(path, saved);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'saved-and-closed' });
  const current = (await readTask(root)).currentDeck!, next = await readTaskRevision(root, current.revisionId);
  assert.deepEqual(await readFile(join(root, current.relativePath)), saved);
  assert.equal(next.topology.entries[0].stableSlideId, parent.topology.entries[2].stableSlideId);
  assert.equal(next.topology.entries[1].management, 'unmanaged');
  assert.equal(next.topology.entries[2].stableSlideId, parent.topology.entries[0].stableSlideId);
  assert.ok(next.topology.deletedStableSlideIds.includes(parent.topology.entries[1].stableSlideId));
  await editTask(root, { pageNumber: 2, mode: 'manual', route: 'direct-edit', instruction: '' });
  assert.deepEqual(await readFile(join(root, (await readTaskSession(root)).candidatePath)), saved);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'reject-edit' });
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'rollback-deck' });
  assert.deepEqual((await readTask(root)).currentDeck, old);
});

test('regenerating one page creates a complete candidate without changing the current or unrelated slides', async () => {
  const { root, plan } = await readyDeck(), initial = (await readTask(root)).currentDeck!;
  let reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'regenerate-page', pageNumber: 2, instruction: 'Improve visual layout; preserve text', callBudget: 1 });
  const job = await readBatchJob(root, (await readTask(root)).activeJobId!);
  assert.equal(job.pages.length, 1); assert.equal(job.pages[0].slideId, plan.slides[1].slideId);
  reply = await generateFixture(root, reply);
  const cp = await readBatchCheckpoint(root, job.jobId);
  reply = await submitWork(root, reply, { pages: [{ slideId: job.pages[0].slideId, sha256: cp.completed[job.pages[0].slideId].sha256, requiredText: [{ text: '标题', present: true }], styleConsistent: true, hierarchyClear: true, forbiddenContentAbsent: true, notes: 'fixture' }] });
  assert.deepEqual((await readTask(root)).currentDeck, initial);
  const session = await readTaskSession(root), before = await JSZip.loadAsync(await readFile(join(root, initial.relativePath))), after = await JSZip.loadAsync(await readFile(join(root, session.candidatePath)));
  for (const page of [1, 3]) assert.equal(await before.file(`ppt/slides/slide${page}.xml`)!.async('string'), await after.file(`ppt/slides/slide${page}.xml`)!.async('string'));
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'confirm-agent-edit', confirmedSha256: session.presentedSha256 });
  assert.equal((await readTask(root)).currentDeck!.revisionId, session.revisionId);
});

test('delivery preserves an existing differently named-content file and selects a semantic suffixed name', async () => {
  const { root } = await readyDeck();
  const occupied = join(root, '交付/效率测试.pptx'); await atomicWrite(occupied, 'user-owned file');
  const reply = await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'confirm-delivery' });
  assert.equal(await readFile(occupied, 'utf8'), 'user-owned file');
  assert.equal(reply.kind, 'done');
  if (reply.kind !== 'done') throw new Error('Expected delivery');
  assert.match(reply.deck.relativePath, /^交付\/效率测试-[a-f0-9]{12}\.pptx$/);
  assert.equal(hash(await readFile(join(root, reply.deck.relativePath))), reply.deck.sha256);
});

test('one-page donor activation and actual text editing retain all other pages, then require candidate confirmation', async () => {
  const { root } = await readyDeck(), initial = (await readTask(root)).currentDeck!;
  let reply = await editTask(root, { pageNumber: 2, mode: 'manual', route: 'activate-editable', instruction: '' });
  const session = await readTaskSession(root);
  const outDir = `editing/${session.id}/converter-output`; await mkdir(join(root, outDir), { recursive: true });
  const input = await readFile(join(root, `editing/${session.id}/input.png`));
  const element = { kind: 'text' as const, id: 'title', text: 'Original', bbox: { x: 100, y: 100, width: 700, height: 120 }, rotation: 0, color: '#17324D', fontSizePx: 32, bold: true, align: 'left' as const, zIndex: 1 };
  const manifest = { manifestVersion: 2, canvas: { width: 1280, height: 720 }, elements: [element], warnings: [] };
  await writeTaskJson(root, outDir + '/manifest.json', manifest);
  await createPresentation([{ id: 'donor', bytes: input, contentType: 'image/png', mode: 'editable', editable: { id: 'donor', cleanBackground: input, elements: [element] } }], join(root, outDir, 'slide-editable.pptx'));
  // Real image-to-editable-pptx exporter uses a 13.333-inch long side for 1280x720.
  const donorPath = join(root, outDir, 'slide-editable.pptx'), donorZip = await JSZip.loadAsync(await readFile(donorPath));
  const donorPresentation = await donorZip.file('ppt/presentation.xml')!.async('string');
  donorZip.file('ppt/presentation.xml', donorPresentation.replace(/<p:sldSz\b[^>]*\/>/, '<p:sldSz cx="12191695" cy="6857829"/>'));
  await atomicWrite(donorPath, await donorZip.generateAsync({ type: 'nodebuffer' }));
  await writeTaskJson(root, outDir + '/run-ledger.json', { ledgerVersion: 2, hashes: { sourceImage: hash(input), manifest: hash(await readFile(join(root, outDir, 'manifest.json'))), pptx: hash(await readFile(join(root, outDir, 'slide-editable.pptx'))) } });
  reply = await submitWork(root, reply, { outDir });
  assert.equal(reply.kind, 'decision'); assert.deepEqual((await readTask(root)).currentDeck, initial);
  await decideTask(root, { decisionId: (await readTask(root)).pendingDecision!.id, action: 'saved-and-closed' });
  const activated = (await readTask(root)).currentDeck!, originalZip = await JSZip.loadAsync(await readFile(join(root, initial.relativePath)));
  const activeZip = await JSZip.loadAsync(await readFile(join(root, activated.relativePath)));
  for (const page of [1, 3]) assert.equal(await activeZip.file(`ppt/slides/slide${page}.xml`)!.async('string'), await originalZip.file(`ppt/slides/slide${page}.xml`)!.async('string'));
  reply = await editTask(root, { pageNumber: 2, mode: 'agent', route: 'direct-edit', instruction: 'Change title' });
  reply = await submitWork(root, reply, { manifestPath: outDir + '/manifest.json', operations: [{ kind: 'replace-text', elementId: 'title', text: 'Changed title' }] });
  const candidate = await readTaskSession(root), bytes = await readFile(join(root, candidate.candidatePath));
  assert.match(await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide2.xml')!.async('string'), /Changed title/);
  assert.deepEqual((await readTask(root)).currentDeck, activated);
  const decisionId = (await readTask(root)).pendingDecision!.id;
  await assert.rejects(() => decideTask(root, { decisionId, action: 'confirm-agent-edit', confirmedSha256: 'wrong' }));
  await decideTask(root, { decisionId, action: 'confirm-agent-edit', confirmedSha256: hash(bytes) });
  assert.deepEqual(await readFile(join(root, (await readTask(root)).currentDeck!.relativePath)), bytes);
});
