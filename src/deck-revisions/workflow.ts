import { z } from "zod";

import { PreparedDeckEditSchema, type PreparedDeckEdit } from "../editable/schemas.js";
import { activateEditableSlideInDeck } from "./activate-slide.js";
import type { ResolvedCurrentDeckPointer } from "./schemas.js";
import {
  adoptDeckCandidate,
  createDeckCandidate,
  presentDeckCandidate,
  readCurrentDeckPointer,
  readDeckEditSession,
  readLocalDeckRevision,
  rejectDeckCandidate,
} from "./store.js";

const PrepareManualEditDeckOptionsSchema = z.object({
  root: z.string().min(1),
  slideId: z.string().uuid(),
  conversionRoot: z.string().min(1).optional(),
}).strict();

const AgentCandidateOptionsSchema = z.object({
  root: z.string().min(1),
  sessionId: z.string().uuid(),
  slideId: z.string().uuid(),
}).strict();

const AdoptionOptionsSchema = z.object({
  root: z.string().min(1),
  sessionId: z.string().uuid(),
}).strict();

function preparedResult(
  mode: "manual" | "agent",
  targetSlideIndex: number,
  presented: Awaited<ReturnType<typeof presentDeckCandidate>>,
): PreparedDeckEdit {
  return PreparedDeckEditSchema.parse({
    kind: "complete-local-pptx",
    mode,
    revisionId: presented.session.candidateRevisionId,
    sessionId: presented.session.sessionId,
    targetSlideId: presented.session.targetSlideId,
    targetSlideIndex,
    absolutePath: presented.session.absolutePath,
    localLink: presented.session.absolutePath,
    sha256: presented.inspected.sha256,
    slideCount: presented.inspected.slideCount,
    editableSlideIds: presented.editableSlideIds,
    reviewRequiredObjects: presented.session.reviewRequiredObjects,
  });
}

export async function prepareManualEditDeck(options: {
  root: string;
  slideId: string;
  conversionRoot?: string;
}): Promise<PreparedDeckEdit> {
  const valid = PrepareManualEditDeckOptionsSchema.parse(options);
  const current = await readCurrentDeckPointer(valid.root);
  const parent = await readLocalDeckRevision(valid.root, current.revisionId);
  const target = parent.slideTopology.entries.find((entry) => entry.stableSlideId === valid.slideId);
  if (!target) throw new Error("manual edit target is not in the reconciled current deck topology");
  const alreadyEditable = parent.editableSlideIds.includes(valid.slideId);
  const candidate = await createDeckCandidate(valid.root, {
    sourceRevisionId: current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [valid.slideId],
    editableSlideIds: parent.editableSlideIds,
    targetSlideId: valid.slideId,
    mode: "manual",
  });
  try {
    if (!alreadyEditable) {
      if (!valid.conversionRoot) {
        throw new Error("manual edit requires an authenticated editable conversion for a non-editable slide");
      }
      await activateEditableSlideInDeck({
        projectRoot: valid.root,
        candidatePath: candidate.absolutePath,
        slideIndex: target.position,
        slideId: valid.slideId,
        conversionRoot: valid.conversionRoot,
      });
    }
    const presented = await presentDeckCandidate(valid.root, {
      sessionId: candidate.sessionId,
      mode: "manual",
      targetSlideId: valid.slideId,
      state: "external-editing",
    });
    return preparedResult("manual", target.position, presented);
  } catch (error: unknown) {
    try {
      const currentSession = await readDeckEditSession(valid.root, candidate.sessionId);
      if (currentSession.state === "prepared") {
        await rejectDeckCandidate(valid.root, {
          sessionId: candidate.sessionId,
          mode: "manual",
          requiredState: "prepared",
        });
      }
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "manual deck preparation failed and its session could not be closed");
    }
    throw error;
  }
}

export async function adoptManualSavedDeck(options: {
  root: string;
  sessionId: string;
  userSignal: string;
}): Promise<ResolvedCurrentDeckPointer> {
  const valid = AdoptionOptionsSchema.extend({ userSignal: z.string() }).parse(options);
  if (options.userSignal !== "saved-and-closed") {
    throw new Error("manual adoption requires the explicit saved-and-closed signal");
  }
  return adoptDeckCandidate(valid.root, {
    sessionId: valid.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
  });
}

export async function beginAgentCandidateConfirmation(options: {
  root: string;
  sessionId: string;
  slideId: string;
}): Promise<PreparedDeckEdit> {
  const valid = AgentCandidateOptionsSchema.parse(options);
  const session = await readDeckEditSession(valid.root, valid.sessionId);
  if (session.mode !== "agent") throw new Error("Agent confirmation cannot target a manual external-editing session");
  const parent = await readLocalDeckRevision(valid.root, session.parentRevisionId);
  const target = parent.slideTopology.entries.find((entry) => entry.stableSlideId === valid.slideId);
  if (!target) throw new Error("Agent edit target is not in the reconciled current deck topology");
  const presented = await presentDeckCandidate(valid.root, {
    sessionId: valid.sessionId,
    mode: "agent",
    targetSlideId: valid.slideId,
    state: "awaiting-confirmation",
  });
  return preparedResult("agent", target.position, presented);
}

export async function confirmAgentEditDeck(options: {
  root: string;
  sessionId: string;
  confirmedSha256: string;
}): Promise<ResolvedCurrentDeckPointer> {
  const valid = AdoptionOptionsSchema.extend({
    confirmedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(options);
  return adoptDeckCandidate(valid.root, {
    sessionId: valid.sessionId,
    mode: "agent",
    confirmedSha256: valid.confirmedSha256,
  });
}

export async function rejectDeckEdit(options: {
  root: string;
  sessionId: string;
}): Promise<void> {
  const valid = AdoptionOptionsSchema.parse(options);
  return rejectDeckCandidate(valid.root, {
    sessionId: valid.sessionId,
    mode: "agent",
    requiredState: "awaiting-confirmation",
  });
}
