import { createHash } from "node:crypto";

import { readRegularFileNoFollow } from "../project/safe-file.js";
import {
  AcceptanceSchema,
  type Acceptance,
  type DeckReviewActionEvidence,
  type CompleteDeckReviewActionEvidence,
} from "./schema.js";

const sha256Bytes = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

async function fileEvidence(path: string): Promise<{ path: string; sha256: string }> {
  return { path, sha256: sha256Bytes(await readRegularFileNoFollow(path)) };
}

export type AcceptanceInput = {
  projectId: string;
  revisionId: string;
  providerId: string;
  gatesCurrent: boolean;
  gateRevisionIds: {
    outline: string;
    slideSpecs: string;
    styleSample: string;
  };
  pages: Array<{
    id: string;
    order: number;
    mode: "image" | "editable";
    status: string;
    finalRender: string;
    finalRenderSha256: string;
  }>;
  exports: { pptx: string; pdf: string; montage: string };
  exportRefs?: { pptx: string; pdf: string; montage: string };
  candidateReview?: {
    candidateId: string;
    projectRevisionId: string;
    projectBindingSha256: string;
  };
  completeDeckReview?: {
    revisionId: string;
    absolutePath: string;
    sha256: string;
  };
  warnings?: string[];
};

export async function buildAcceptance(input: AcceptanceInput): Promise<Acceptance> {
  if (!input.gatesCurrent) throw new Error("all three planning gates must be current");
  if (input.pages.length === 0 || input.pages.some((page) => !["ready", "editable"].includes(page.status))) {
    throw new Error("all pages must be ready before acceptance");
  }
  const orders = new Set<number>();
  const ids = new Set<string>();
  for (const page of input.pages) {
    if (orders.has(page.order)) throw new Error("acceptance page order must be unique");
    if (ids.has(page.id)) throw new Error("acceptance page id must be unique");
    orders.add(page.order);
    ids.add(page.id);
  }
  const ordered = [...input.pages].sort((left, right) => left.order - right.order);
  if (ordered.some((page, index) => page.order !== index)) {
    throw new Error("acceptance page order must be contiguous from zero");
  }
  const slides = await Promise.all(ordered.map(async (page) => {
    const actual = sha256Bytes(await readRegularFileNoFollow(page.finalRender));
    if (actual !== page.finalRenderSha256) {
      throw new Error(`final render hash does not match for page ${page.id}`);
    }
    return {
      id: page.id,
      order: page.order,
      mode: page.mode,
      finalRenderSha256: actual,
    };
  }));
  return AcceptanceSchema.parse({
    schemaVersion: 1,
    projectId: input.projectId,
    revisionId: input.revisionId,
    slides,
    exports: {
      pptx: { ...await fileEvidence(input.exports.pptx), path: input.exportRefs?.pptx ?? input.exports.pptx },
      pdf: { ...await fileEvidence(input.exports.pdf), path: input.exportRefs?.pdf ?? input.exports.pdf },
      montage: { ...await fileEvidence(input.exports.montage), path: input.exportRefs?.montage ?? input.exports.montage },
    },
    gates: input.gateRevisionIds,
    providerId: input.providerId,
    editablePageIds: slides.filter((slide) => slide.mode === "editable").map((slide) => slide.id),
    warnings: input.warnings ?? [],
    ...(input.candidateReview ? { candidateReview: input.candidateReview } : {}),
    ...(input.completeDeckReview ? { completeDeckReview: input.completeDeckReview } : {}),
    deliveryComplete: false,
    clientAcceptance: {
      application: null,
      observation: null,
      smokeCopy: null,
      selectedObject: null,
      temporaryEditObserved: false,
      undoObserved: false,
      saveDecision: null,
      reopenObserved: false,
      observedResult: null,
      confirmedAt: null,
    },
  });
}

export function bindConfirmedCompleteDeckReview(
  acceptance: Acceptance,
  action: CompleteDeckReviewActionEvidence,
): Acceptance {
  if (action.action !== "confirm-delivery") {
    throw new Error("only confirm-delivery may bind formal complete-deck acceptance");
  }
  if (
    acceptance.projectId !== action.projectId
    || acceptance.revisionId !== action.projectRevisionId
    || acceptance.completeDeckReview?.revisionId !== action.revisionId
    || acceptance.completeDeckReview.absolutePath !== action.absolutePath
    || acceptance.completeDeckReview.sha256 !== action.deckSha256
  ) throw new Error("confirm-delivery action does not bind the exact complete local deck");
  return AcceptanceSchema.parse({
    ...acceptance,
    completeDeckReviewConfirmation: {
      actionId: action.actionId,
      action: action.action,
      revisionId: action.revisionId,
      deckSha256: action.deckSha256,
      actionEvidenceSha256: action.actionEvidenceSha256,
    },
  });
}

export function bindConfirmedDeckReview(
  acceptance: Acceptance,
  action: DeckReviewActionEvidence,
): Acceptance {
  if (action.action !== "confirm-delivery") {
    throw new Error("only confirm-delivery may bind formal acceptance");
  }
  if (
    acceptance.projectId !== action.projectId
    || acceptance.revisionId !== action.projectRevisionId
    || acceptance.candidateReview?.candidateId !== action.candidateId
    || acceptance.candidateReview.projectRevisionId !== action.projectRevisionId
  ) throw new Error("confirm-delivery action does not bind candidate acceptance");
  return AcceptanceSchema.parse({
    ...acceptance,
    deckReviewConfirmation: {
      actionId: action.actionId,
      action: action.action,
      candidateId: action.candidateId,
      actionEvidenceSha256: action.actionEvidenceSha256,
    },
  });
}
