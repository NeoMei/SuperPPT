import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { readTask, updateTask, readTaskJson, writeTaskJson, taskTransaction, hash, readArtifact, taskPath } from '../project/task-store.js';
import { PlanBundleSchema, type WorkflowReply } from './contracts.js';
import { publishPlan, planReviewReply } from './planning.js';
import { acceptBatchResult, BatchResultSchema, readBatchJob, readBatchCheckpoint, jobPath } from '../generation/task-batch.js';
import { assembleTaskDeck, readTaskSession, readTaskRevision, deckLink, presentTaskEdit } from '../deck-revisions/task-deck.js';
import { submissionNote } from '../generation/image-intent.js';
import { reuseCompletedPages } from './reuse.js';

export async function taskReply(root: string): Promise<WorkflowReply> {
  const s = await readTask(root);
  if (s.work) return { kind: 'work', work: s.work };
  if (s.stage === 'delivered' && s.delivery) return { kind: 'done', deck: s.delivery, link: deckLink(root, s.delivery) };
  if (!s.pendingDecision) return { kind: 'attention', reason: 'No action ready; run continue to recover' };
  if (s.pendingDecision.kind === 'generation-recovery') return { kind: 'decision', id: s.pendingDecision.id, stage: 'generation-recovery', view: '本批次未完成且预算已用完。成功页已保存；可授权 retry-generation 仅继续剩余页，或 revise-plan 修改内容。', details: await readBatchCheckpoint(root, s.activeJobId!) };
  if (s.pendingDecision.kind === 'quality-review') return { kind: 'decision', id: s.pendingDecision.id, stage: 'quality-review', view: '图片检查发现问题，请确认需要调整的页面或内容；使用 revise-plan 提交修改要求。未通过页面不会进入交付。', details: await readTaskJson(root, `${jobPath(s.activeJobId!)}/qa.json`) };
  if (s.editSessionPath) {
    const session = await readTaskSession(root);
    return { kind: 'decision', id: s.pendingDecision.id, stage: 'edit-review', view: `${deckLink(root, { revisionId: session.revisionId, relativePath: session.candidatePath, sha256: session.presentedSha256! })}\n${session.mode === 'manual' ? '保存并关闭后回复“已保存并关闭”。' : '请回看后确认修改，或拒绝此候选。'}`, details: session };
  }
  if (s.stage === 'plan-review') {
    const plan = PlanBundleSchema.parse(await readTaskJson(root, s.planPath!));
    return planReviewReply(root, plan, s.contentRevision, s.pendingDecision.id);
  }
  if (s.stage === 'sample-review') {
    const result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(s.activeJobId!)}/result.json`));
    const plan = PlanBundleSchema.parse(await readTaskJson(root, s.planPath!));
    const promptsPath = `planning/${s.contentRevision}/deck-prompts.json`;
    const job = await readBatchJob(root, s.activeJobId!);
    const prompts = await readTaskJson(root, promptsPath) as Record<string, string>;
    const preview = await reuseCompletedPages(root, plan, { ...job, kind: 'deck', styleLock: { ...job.styleLock, approvalState: 'approved', approvedSample: result.pages[0].artifact }, pages: plan.outline.slides.map(p => ({ slideId: p.id, prompt: prompts[p.id], target: '', cached: null })) });
    const reusedSlideIds = preview.pages.filter(p => p.cached).map(p => p.slideId);
    const generationPageCount = preview.pages.length - reusedSlideIds.length;
    return { kind: 'decision', id: s.pendingDecision.id, stage: s.stage, view: `样页：${await taskPath(root, result.pages[0].artifact!.path)}\n确认无修改后复用样页及其他未变页面（整套 ${plan.slides.length} 页，复用 ${reusedSlideIds.length} 页，新生成 ${generationPageCount} 页，默认最多新增 ${generationPageCount} 次外部调用）。`, details: { sample: result.pages[0].artifact, promptsPath, submissionNote: submissionNote(job.generationIntent), references: plan.references, pageCount: plan.slides.length, generationPageCount, reusedSlideIds, callBudget: generationPageCount, output: `${root}/generation`, executor: 'ai-image-to-ppt' } };
  }
  if (!s.currentDeck) throw new Error('Current complete PPTX missing');
  return { kind: 'decision', id: s.pendingDecision.id, stage: 'deck-review', view: `${deckLink(root, s.currentDeck)}\n修改某页 / 返回修改内容或风格 / 确认交付`, details: s.currentDeck };
}

export async function continueTask(root: string, resultPath?: string): Promise<WorkflowReply> {
  return taskTransaction(root, async () => {
    let s = await readTask(root);
    if (resultPath) {
      const bytes = await readFile(resultPath), resultHash = hash(bytes);
      if (bytes.length > 16 * 1024 * 1024) throw new Error('Work result exceeds 16 MB');
      const envelope = z.object({ workId: z.string().uuid(), contentRevision: z.string().uuid(), payload: z.unknown() }).strict().parse(JSON.parse(bytes.toString('utf8')));
      if (s.lastResult?.id === envelope.workId) {
        if (s.lastResult.sha256 !== resultHash) throw new Error('Completed work result changed');
        return taskReply(root);
      }
      if (!s.work || s.work.id !== envelope.workId || envelope.contentRevision !== s.contentRevision) throw new Error('Stale or unexpected work result');
      const work = s.work;
      if (work.kind === 'plan') await publishPlan(root, envelope.payload);
      else if (work.kind === 'generate-batch') {
        const result = await acceptBatchResult(root, envelope.payload);
        if (result.outcome !== 'success') {
          const job = await readBatchJob(root, s.activeJobId!);
          if (result.requestCount >= job.callBudget) {
            await updateTask(root, state => ({ ...state, work: null, pendingDecision: { id: randomUUID(), kind: 'generation-recovery' }, lastResult: { id: envelope.workId, sha256: resultHash } }));
            return taskReply(root);
          }
          return { kind: 'attention', reason: 'Batch incomplete. Resume the same job and checkpoint; do not regenerate completed pages.' };
        }
        const job = await readBatchJob(root, s.activeJobId!);
        if (job.kind === 'style-sample') {
          const style = { ...job.styleLock, approvalState: 'approved', approvedSample: result.pages[0].artifact };
          // Deck prompts are disclosed before sample approval authorizes their job.
          const plan = PlanBundleSchema.parse(await readTaskJson(root, s.planPath!));
          const { compileSlidePrompt } = await import('../styles/prompt-compiler.js');
          await writeTaskJson(root, `planning/${s.contentRevision}/deck-prompts.json`, Object.fromEntries(plan.slides.map(page => [page.slideId, compileSlidePrompt({ spec: page, style: style.recipe }).text])));
          await updateTask(root, state => ({ ...state, stage: 'sample-review', work: null, pendingDecision: { id: randomUUID(), kind: 'sample-review' } }));
        } else await updateTask(root, state => ({ ...state, stage: 'deck-qa', work: null }));
      } else if (work.kind === 'review-images') {
        const result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(s.activeJobId!)}/result.json`));
        const qa = z.object({ pages: z.array(z.object({ slideId: z.string(), sha256: z.string(), requiredText: z.array(z.object({ text: z.string(), present: z.boolean() })), styleConsistent: z.boolean(), hierarchyClear: z.boolean(), forbiddenContentAbsent: z.boolean(), notes: z.string() })) }).strict().parse(envelope.payload);
        const plan = PlanBundleSchema.parse(await readTaskJson(root, s.planPath!));
        if (qa.pages.length !== result.pages.length || new Set(qa.pages.map(p => p.slideId)).size !== result.pages.length) throw new Error('QA must cover every generated page');
        for (const page of qa.pages) {
          const image = result.pages.find(p => p.slideId === page.slideId)?.artifact, spec = plan.slides.find(p => p.slideId === page.slideId);
          if (!image || page.sha256 !== image.sha256 || !spec || page.requiredText.length !== spec.requiredText.length || spec.requiredText.some((text, i) => page.requiredText[i]?.text !== text)) throw new Error('QA does not match current images and text');
          if (!page.styleConsistent || !page.hierarchyClear || !page.forbiddenContentAbsent || page.requiredText.some(t => !t.present)) {
            await writeTaskJson(root, `${jobPath(s.activeJobId!)}/qa.json`, qa);
            await updateTask(root, state => ({ ...state, work: null, pendingDecision: { id: randomUUID(), kind: 'quality-review' }, lastResult: { id: envelope.workId, sha256: resultHash } }));
            return taskReply(root);
          }
        }
        await writeTaskJson(root, `${jobPath(s.activeJobId!)}/qa.json`, qa);
        await assembleTaskDeck(root);
      } else if (work.kind === 'convert-page') {
        const { finishTaskConversion } = await import('../editable/task-conversion.js');
        await finishTaskConversion(root, envelope.payload);
      } else if (work.kind === 'edit-deck') {
        const edit = z.union([z.object({ edited: z.literal(true) }).strict(), z.object({ manifestPath: z.string(), operations: z.array(z.unknown()).min(1) }).strict()]).parse(envelope.payload);
        if ('operations' in edit) {
          const session = await readTaskSession(root), parent = await readTaskRevision(root, session.parent.revisionId);
          const entry = parent.topology.entries.find(e => e.stableSlideId === session.targetSlideId)!;
          const { applySlideOperations } = await import('../deck-revisions/task-edit.js');
          // Operations are absolute edits (replacement/geometry/style), so replay is idempotent.
          await applySlideOperations(await taskPath(root, session.candidatePath), entry.slidePart, await readTaskJson(root, edit.manifestPath), edit.operations);
        }
        await presentTaskEdit(root);
      }
      await updateTask(root, state => ({ ...state, lastResult: { id: envelope.workId, sha256: resultHash } }));
      s = await readTask(root);
    }
    if (s.work?.kind === 'generate-batch') {
      const cp = await readBatchCheckpoint(root, s.activeJobId!);
      if (cp.inFlightSlideId) return { kind: 'attention', reason: `第 ${cp.inFlightSlideId} 页请求结果不明；先确认已有产物，不自动重复付费。` };
      for (const artifact of Object.values(cp.completed)) if (hash(await readArtifact(root, artifact.path)) !== artifact.sha256) throw new Error('Saved page changed; restore it before resuming this batch');
    }
    if (s.work || s.pendingDecision || s.stage === 'delivered') return taskReply(root);
    const id = randomUUID();
    if (s.stage === 'planning') {
      const inputPath = `planning/${s.contentRevision}/request.json`;
      await writeTaskJson(root, inputPath, { source: s.sourcePath, title: s.title, previous: `planning/${s.contentRevision}/previous.json`, instructions: 'Read source and previous.json if present; apply its requested change. Preserve IDs and exact specs for unchanged pages. Write complete Brief/Outline/SlideSpecs. By default read assets/styles/catalog.json and include every built-in style from the full catalog; preserve an explicitly requested custom style with the same tier/palette contract instead of replacing it. requiredText includes the title and all approved visible copy verbatim without a line-count cap. relationships describe content meaning, not a prescribed picture or layout. The plan review shows all styles first, then each style\'s available creativity levels and palettes together; do not create separate approval rounds or generate selection previews. Retain source coverage; ask only materially missing facts.' });
      await updateTask(root, state => ({ ...state, work: { id, kind: 'plan', inputPath, resultPath: `planning/${s.contentRevision}/result.json` } }));
    } else if (s.stage === 'sample-generation' || s.stage === 'deck-generation') {
      const cp = await readBatchCheckpoint(root, s.activeJobId!);
      if (cp.inFlightSlideId) return { kind: 'attention', reason: `第 ${cp.inFlightSlideId} 页请求结果不明；先确认已有产物，不自动重复付费。` };
      await updateTask(root, state => ({ ...state, work: { id, kind: 'generate-batch', inputPath: `${jobPath(s.activeJobId!)}/job.json`, resultPath: `${jobPath(s.activeJobId!)}/work-result.json` } }));
    } else if (s.stage === 'deck-qa') {
      const inputPath = `${jobPath(s.activeJobId!)}/qa-request.json`;
      await writeTaskJson(root, inputPath, { planPath: s.planPath, jobPath: `${jobPath(s.activeJobId!)}/job.json`, resultPath: `${jobPath(s.activeJobId!)}/result.json`, instructions: 'Inspect all images against requiredText, approved style, hierarchy, forbidden content. Return actual per-page observations bound to the image SHA; do not infer visual success from metadata.' });
      await updateTask(root, state => ({ ...state, work: { id, kind: 'review-images', inputPath, resultPath: `${jobPath(s.activeJobId!)}/qa-result.json` } }));
    }
    return taskReply(root);
  });
}
