import { referenceDirection } from '../generation/style-reference.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { readTask, updateTask, readTaskJson, writeTaskJson, taskTransaction, hash, readArtifact, taskPath } from '../project/task-store.js';
import { PlanBundleSchema, type WorkflowReply } from './contracts.js';
import { publishPlan, planReviewReply } from './planning.js';
import { acceptBatchResult, BatchResultSchema, readBatchJob, readBatchCheckpoint, jobPath, validateImage } from '../generation/task-batch.js';
import { assembleTaskDeck, readTaskSession, readTaskRevision, deckLink, presentTaskEdit } from '../deck-revisions/task-deck.js';
import { submissionNote } from '../generation/image-intent.js';
import { reuseCompletedPages, SampleReferenceEvidenceError } from './reuse.js';
import { ensurePlanningContext } from '../planning/context.js';

export async function taskReply(root: string): Promise<WorkflowReply> {
  const s = await readTask(root);
  if (s.work) return { kind: 'work', work: s.work };
  if (s.stage === 'delivered' && s.delivery) return { kind: 'done', deck: s.delivery, link: deckLink(root, s.delivery) };
  if (!s.pendingDecision) return { kind: 'attention', reason: 'No action ready; run continue to recover' };
  if (s.pendingDecision.kind === 'generation-recovery') return { kind: 'decision', id: s.pendingDecision.id, stage: 'generation-recovery', view: '本批次未完成且预算已用完。成功页已保存；可授权 retry-generation 仅继续剩余页，或 revise-plan 修改内容。', details: await readBatchCheckpoint(root, s.activeJobId!) };
  if (s.pendingDecision.kind === 'quality-review') {
    const qa = await readTaskJson(root, `${jobPath(s.activeJobId!)}/qa.json`);
    let sample = '';
    if (s.stage === 'sample-qa') {
      const result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(s.activeJobId!)}/result.json`));
      const artifact = result.pages[0]?.artifact;
      if (!artifact) throw new Error('Sample image is missing');
      await validateImage(root, artifact);
      sample = `未通过检查的样页：[查看样页](<${await taskPath(root, artifact.path)}>)\n`;
    }
    return { kind: 'decision', id: s.pendingDecision.id, stage: 'quality-review', view: `${sample}图片检查发现问题，请确认需要调整的页面或内容；使用 revise-plan 提交修改要求。未通过页面不会进入交付。`, details: qa };
  }
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
    let preview;
    try {
      preview = await reuseCompletedPages(root, plan, { ...job, kind: 'deck', styleLock: { ...job.styleLock, approvalState: 'approved', approvedSample: result.pages[0].artifact }, pages: plan.outline.slides.map(p => ({ slideId: p.id, prompt: prompts[p.id], target: '', cached: null })) });
    } catch (error) {
      if (error instanceof SampleReferenceEvidenceError) return { kind: 'attention', reason: error.message };
      throw error;
    }
    const reusedSlideIds = preview.pages.filter(p => p.cached).map(p => p.slideId);
    const generationPageCount = preview.pages.length - reusedSlideIds.length;
    return { kind: 'decision', id: s.pendingDecision.id, stage: s.stage, view: `样页：${await taskPath(root, result.pages[0].artifact!.path)}\n确认无修改后复用样页及其他未变页面（整套 ${plan.slides.length} 页，复用 ${reusedSlideIds.length} 页，新生成 ${generationPageCount} 页，默认最多新增 ${generationPageCount} 次外部调用）。`, details: { sample: result.pages[0].artifact, promptsPath, submissionNote: submissionNote(job.generationIntent), ...(job.styleLock.referencePolicy === 'required' ? { referenceDirection } : {}), references: [...(job.styleLock.referencePolicy === 'required' ? [{ ...result.pages[0].artifact!, role: 'art-direction' }] : []), ...plan.references], pageCount: plan.slides.length, generationPageCount, reusedSlideIds, callBudget: generationPageCount, output: `${root}/generation`, executor: 'ai-image-to-ppt' } };
  }
  if (!s.currentDeck) throw new Error('Current complete PPTX missing');
  return { kind: 'decision', id: s.pendingDecision.id, stage: 'deck-review', view: `${deckLink(root, s.currentDeck)}\n修改某页 / 返回修改内容或风格 / 确认交付`, details: s.currentDeck };
}

export async function continueTask(root: string, resultPath?: string): Promise<WorkflowReply> {
  return taskTransaction(root, async () => {
    let s = await readTask(root);
    if (resultPath) {
      if (!isAbsolute(resultPath)) throw new Error('Work result must use the current declared result path');
      const actualPath = await realpath(resultPath);
      const base = await realpath(root), relativePath = relative(base, actualPath);
      if (!relativePath || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) throw new Error('Work result must use the current declared result path');
      const resultRelativePath = relativePath.split(sep).join('/');
      const currentPath = s.work?.resultPath;
      const previousPath = s.lastResult?.path;
      const legacyReplay = !!s.lastResult && !previousPath;
      if (resultRelativePath !== currentPath && resultRelativePath !== previousPath && !legacyReplay) throw new Error('Work result must use the current declared result path');
      const bytes = await readArtifact(root, resultRelativePath, 16 * 1024 * 1024), resultHash = hash(bytes);
      const envelope = z.object({ workId: z.string().uuid(), contentRevision: z.string().uuid(), payload: z.unknown() }).strict().parse(JSON.parse(bytes.toString('utf8')));
      if (s.lastResult?.id === envelope.workId) {
        if (s.lastResult.sha256 !== resultHash) throw new Error('Completed work result changed');
        return taskReply(root);
      }
      if (!s.work || resultRelativePath !== currentPath || s.work.id !== envelope.workId || envelope.contentRevision !== s.contentRevision) throw new Error('Stale or unexpected work result');
      const work = s.work;
      if (work.kind === 'plan') await publishPlan(root, envelope.payload);
      else if (work.kind === 'generate-batch') {
        const result = await acceptBatchResult(root, envelope.payload);
        if (result.outcome !== 'success') {
          const job = await readBatchJob(root, s.activeJobId!);
          if (result.requestCount >= job.callBudget) {
            await updateTask(root, state => ({ ...state, work: null, pendingDecision: { id: randomUUID(), kind: 'generation-recovery' }, lastResult: { id: envelope.workId, sha256: resultHash, path: work.resultPath } }));
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
          await writeTaskJson(root, `planning/${s.contentRevision}/deck-prompts.json`, Object.fromEntries(plan.slides.map(page => [
            page.slideId,
            page.slideId === job.pages[0]!.slideId ? job.pages[0]!.prompt : compileSlidePrompt({ spec: page, style: style.recipe }).text,
          ])));
          await updateTask(root, state => ({ ...state, stage: 'sample-qa', work: null }));
        } else await updateTask(root, state => ({ ...state, stage: 'deck-qa', work: null }));
      } else if (work.kind === 'review-images') {
        const result = BatchResultSchema.parse(await readTaskJson(root, `${jobPath(s.activeJobId!)}/result.json`));
        const qa = z.object({ pages: z.array(z.object({ slideId: z.string(), sha256: z.string(), requiredText: z.array(z.object({ text: z.string(), present: z.boolean() })), styleConsistent: z.boolean(), hierarchyClear: z.boolean(), forbiddenContentAbsent: z.boolean(), notes: z.string() })) }).strict().parse(envelope.payload);
        const plan = PlanBundleSchema.parse(await readTaskJson(root, s.planPath!));
        if (qa.pages.length !== result.pages.length || new Set(qa.pages.map(p => p.slideId)).size !== result.pages.length) throw new Error('QA must cover every generated page');
        for (const page of qa.pages) {
          const image = result.pages.find(p => p.slideId === page.slideId)?.artifact, spec = plan.slides.find(p => p.slideId === page.slideId);
          if (!image || page.sha256 !== image.sha256 || !spec || page.requiredText.length !== spec.requiredText.length || spec.requiredText.some((text, i) => page.requiredText[i]?.text !== text)) throw new Error('QA does not match current images and text');
          await validateImage(root, image);
        }
        if (s.stage === 'sample-qa' && qa.pages.some(page => !page.notes.trim())) throw new Error('Sample QA requires actual observations');
        await writeTaskJson(root, `${jobPath(s.activeJobId!)}/qa.json`, qa);
        if (qa.pages.some(page => !page.styleConsistent || !page.hierarchyClear || !page.forbiddenContentAbsent || page.requiredText.some(t => !t.present))) {
          await updateTask(root, state => ({ ...state, work: null, pendingDecision: { id: randomUUID(), kind: 'quality-review' }, lastResult: { id: envelope.workId, sha256: resultHash, path: work.resultPath } }));
          return taskReply(root);
        }
        if (s.stage === 'sample-qa') {
          await updateTask(root, state => ({ ...state, stage: 'sample-review', work: null, pendingDecision: { id: randomUUID(), kind: 'sample-review' } }));
        } else await assembleTaskDeck(root);
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
      await updateTask(root, state => ({ ...state, lastResult: { id: envelope.workId, sha256: resultHash, path: work.resultPath } }));
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
      const planningContextPath = await ensurePlanningContext(root, s.contentRevision);
      await writeTaskJson(root, inputPath, { source: s.sourcePath, title: s.title, previous: `planning/${s.contentRevision}/previous.json`, planningContextPath, instructions: 'Read source, planningContextPath, and previous.json if present before deciding what is still missing; apply any requested change. Update planningContextPath immediately after every user answer, preserving all facts and preferences supplied together and the current visible assumptions. Ask only when a missing fact would materially change the narrative, content selection, page count, or delivery scope. Ask exactly one highest-impact question at a time; do not join audience and goal into one item labelled “关键一点” or otherwise. For a topic-only request, ask audience alone first with 2-3 options, put the recommended option first, and explain why; only on the next turn ask the purpose if it is still unknown. A factual source gap is likewise one question requesting only that source fact. Complete, goal-clear material should go directly to a complete plan. Low-impact reversible preferences become visible assumptions. Never invent numbers, conclusions, promises, or unsupported Brief fields such as duration; place a duration constraint in the existing constraints/context fields. Comparing multiple approaches is optional and only for materially different narratives. Preserve user-approved structure and copy unless revision is authorized. A style choice alone is not sample-generation authorization: disclose the exact selected prompt, references, output, and one-call budget before accepting explicit generation approval. Preserve IDs and exact specs for unchanged pages. Write complete Brief/Outline/SlideSpecs. By default read assets/styles/catalog.json and include every built-in style from the full catalog; preserve an explicitly requested custom style with the same tier/palette contract instead of replacing it. requiredText includes the title and all approved visible copy verbatim without a line-count cap. relationships describe content meaning, not a prescribed picture or layout. The plan review shows all styles first, then each style\'s available creativity levels and palettes together; do not create separate approval rounds or generate selection previews. Retain source coverage.' });
      await updateTask(root, state => ({ ...state, work: { id, kind: 'plan', inputPath, resultPath: `planning/${s.contentRevision}/result.json` } }));
    } else if (s.stage === 'sample-generation' || s.stage === 'deck-generation') {
      const cp = await readBatchCheckpoint(root, s.activeJobId!);
      if (cp.inFlightSlideId) return { kind: 'attention', reason: `第 ${cp.inFlightSlideId} 页请求结果不明；先确认已有产物，不自动重复付费。` };
      await updateTask(root, state => ({ ...state, work: { id, kind: 'generate-batch', inputPath: `${jobPath(s.activeJobId!)}/job.json`, resultPath: `${jobPath(s.activeJobId!)}/work-result.json` } }));
    } else if (s.stage === 'sample-qa' || s.stage === 'deck-qa') {
      const inputPath = `${jobPath(s.activeJobId!)}/qa-request.json`;
      await writeTaskJson(root, inputPath, { planPath: s.planPath, jobPath: `${jobPath(s.activeJobId!)}/job.json`, resultPath: `${jobPath(s.activeJobId!)}/result.json`, instructions: 'Inspect every image against its requiredText, coreMessage, relationships, approved style, hierarchy and forbidden content. Check that core and required text are legible, complete and not crowded, obscured or sidelined; use a contrasting backing only where needed. For pages whose selected style and content call for creative graphics, check that graphics actively and meaningfully express the text and actual relationships, not merely decorate the page or serve as a background. Assess whether text and graphics together make the message understandable at a glance. Do not fail an expressive graphic for visual prominence alone: no fixed text-to-graphic ratio or mandatory backing applies. Set hierarchyClear to false if a page requiring creative graphics uses them merely as decoration, if graphics misrepresent meaning or relationships, or if text is crowded out; describe actual observations in notes. Return observations bound to the image SHA; do not infer visual success from metadata.' });
      await updateTask(root, state => ({ ...state, work: { id, kind: 'review-images', inputPath, resultPath: `${jobPath(s.activeJobId!)}/qa-result.json` } }));
    }
    return taskReply(root);
  });
}
