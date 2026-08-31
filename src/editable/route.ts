import { z } from "zod";

import { EditableManifestV2Schema, Sha256Schema } from "./schemas.js";
import { EditOperationSchema, type EditOperation } from "./operations.js";

export const DeckEditRouteSchema = z.discriminatedUnion("route", [
  z.object({
    route: z.literal("direct-edit"),
    currentRevisionId: z.string().uuid(),
    slideId: z.string().uuid(),
    operations: z.array(EditOperationSchema).min(1),
  }).strict(),
  z.object({
    route: z.literal("activate-editable"),
    currentRevisionId: z.string().uuid(),
    slideId: z.string().uuid(),
    operations: z.array(EditOperationSchema),
  }).strict(),
  z.object({
    route: z.literal("regenerate-slide"),
    currentRevisionId: z.string().uuid(),
    slideId: z.string().uuid(),
    reason: z.string().min(1),
    styleLockSha256: Sha256Schema,
  }).strict(),
]);

export const DeckEditRequestSchema = z.object({
  change: z.enum([
    "text",
    "number",
    "style",
    "asset",
    "layout",
    "background",
    "illustration",
    "material",
    "composition",
  ]),
  instruction: z.string().trim().min(1).optional(),
  operations: z.array(EditOperationSchema).optional(),
}).strict();

export const DeckEditContextSchema = z.object({
  slideId: z.string().uuid(),
  currentRevisionId: z.string().uuid(),
  editableSlideIds: z.array(z.string().uuid()),
  manifest: EditableManifestV2Schema,
  pageDescription: z.string().min(1),
  styleLockSha256: Sha256Schema,
}).strict();

export type DeckEditRoute = z.infer<typeof DeckEditRouteSchema>;
export type DeckEditRequest = z.infer<typeof DeckEditRequestSchema>;
export type DeckEditContext = z.infer<typeof DeckEditContextSchema>;
export type DeckEditMode = "manual" | "agent";

export const DECK_EDIT_MODE_QUESTION = "需要我帮你修改，还是由你手动修改？";

const REGENERATION_CHANGES = new Set<DeckEditRequest["change"]>([
  "layout",
  "background",
  "illustration",
  "material",
  "composition",
]);

function targetMatches(operation: EditOperation, manifest: DeckEditContext["manifest"]): boolean {
  const element = manifest.elements.find((candidate) => candidate.id === operation.elementId);
  if (!element) return false;
  if (operation.kind === "replace-text" || operation.kind === "set-text-style") return element.kind === "text";
  if (operation.kind === "move-shape" || operation.kind === "set-shape-style") return element.kind === "shape";
  if (operation.kind === "move-asset") return element.kind === "asset";
  return false;
}

function regenerationReason(request: DeckEditRequest, fallback: string): string {
  return request.instruction ?? fallback;
}

export function classifyDeckEdit(rawRequest: unknown, rawContext: unknown): DeckEditRoute {
  const request = DeckEditRequestSchema.parse(rawRequest);
  const context = DeckEditContextSchema.parse(rawContext);
  const forceRegeneration = request.instruction?.includes("不要转可编辑")
    || request.instruction?.includes("直接重做这一页");
  if (forceRegeneration || REGENERATION_CHANGES.has(request.change)) {
    return DeckEditRouteSchema.parse({
      route: "regenerate-slide",
      currentRevisionId: context.currentRevisionId,
      slideId: context.slideId,
      reason: regenerationReason(request, `${request.change} changes require slide regeneration`),
      styleLockSha256: context.styleLockSha256,
    });
  }
  const operations = request.operations ?? [];
  if (operations.length === 0 || operations.some((operation) => !targetMatches(operation, context.manifest))) {
    return DeckEditRouteSchema.parse({
      route: "regenerate-slide",
      currentRevisionId: context.currentRevisionId,
      slideId: context.slideId,
      reason: regenerationReason(request, "the requested target is not reliably editable in the authenticated page binding"),
      styleLockSha256: context.styleLockSha256,
    });
  }
  return DeckEditRouteSchema.parse({
    route: context.editableSlideIds.includes(context.slideId) ? "direct-edit" : "activate-editable",
    currentRevisionId: context.currentRevisionId,
    slideId: context.slideId,
    operations,
  });
}

export function classifyDeckEditMode(rawRequest: unknown): DeckEditMode | null {
  const request = DeckEditRequestSchema.parse(rawRequest);
  if (request.instruction?.includes("我自己改")) return "manual";
  if (request.instruction?.includes("帮我改")) return "agent";
  return null;
}

export function describeDeckEditRoute(rawRoute: unknown): string {
  const route = DeckEditRouteSchema.parse(rawRoute);
  if (route.route === "direct-edit") return "这次会直接修改目标对象，并把结果放在一份完整的本地 PPTX 候选中。";
  if (route.route === "activate-editable") return "这次会先把目标页转为可编辑，再在一份完整的本地 PPTX 候选中修改。";
  return "这次会重做目标页，并只把该页结果写入一份完整的本地 PPTX 候选。";
}

export function describeUpstreamDeckChange(change: "outline" | "slide-description" | "style"): string {
  if (change === "outline") return "修改大纲会影响对应页描述及下游生成证据，确认后这些结果会失效并按影响范围重新生成。";
  if (change === "slide-description") return "修改第 N 页描述会影响该页生成证据，确认后该页结果会失效并重新生成。";
  return "换风格会影响风格样张、生成授权和后续页面结果，确认后相关证据会失效并重新生成。";
}

export type PrepareAgentEditDeckOptions = {
  root: string;
  route: DeckEditRoute;
  conversionRoot?: string;
  generationJobId?: string;
};

export async function prepareAgentEditDeck(options: PrepareAgentEditDeckOptions) {
  const valid = z.object({
    root: z.string().min(1),
    route: DeckEditRouteSchema,
    conversionRoot: z.string().min(1).optional(),
    generationJobId: z.string().uuid().optional(),
  }).strict().parse(options);
  const [{ createDeckCandidate, readCurrentDeckPointer, readDeckEditSession, readLocalDeckRevision, rejectDeckCandidate }, { beginAgentCandidateConfirmation }] = await Promise.all([
    import("../deck-revisions/store.js"),
    import("../deck-revisions/workflow.js"),
  ]);
  const current = await readCurrentDeckPointer(valid.root);
  if (current.revisionId !== valid.route.currentRevisionId) throw new Error("deck edit route is stale for the current complete deck revision");
  const parent = await readLocalDeckRevision(valid.root, current.revisionId);
  const target = parent.slideTopology.entries.find((entry) => entry.stableSlideId === valid.route.slideId);
  if (!target) throw new Error("deck edit route target is absent from the current reconciled topology");
  if (valid.route.route === "direct-edit" && !parent.editableSlideIds.includes(valid.route.slideId)) {
    throw new Error("direct-edit route target is not currently editable");
  }
  if (valid.route.route === "activate-editable" && parent.editableSlideIds.includes(valid.route.slideId)) {
    throw new Error("activate-editable route target is already editable");
  }
  const editableSlideIds = valid.route.route === "regenerate-slide"
    ? parent.editableSlideIds.filter((slideId) => slideId !== valid.route.slideId)
    : parent.editableSlideIds;
  const candidate = await createDeckCandidate(valid.root, {
    sourceRevisionId: current.revisionId,
    reason: valid.route.route === "regenerate-slide" ? "slide-regeneration" : "agent-edit",
    changedSlideIds: [valid.route.slideId],
    editableSlideIds,
    targetSlideId: valid.route.slideId,
    mode: "agent",
  });
  try {
    if (valid.route.route === "regenerate-slide") {
      if (!valid.generationJobId) throw new Error("slide regeneration requires an authenticated generation job ID");
      const { readAndReauthenticateDelegatedResult } = await import("../generation/delegation-result.js");
      const authenticated = await readAndReauthenticateDelegatedResult(valid.root, valid.generationJobId);
      if (authenticated.job.projectRevisionId !== parent.projectRevisionId) {
        throw new Error("regeneration job project revision is stale for the current complete deck revision");
      }
      const page = authenticated.result.pages.find((result) => result.slideId === valid.route.slideId);
      if (authenticated.job.kind !== "page-regeneration"
        || authenticated.job.styleLockSha256 !== valid.route.styleLockSha256
        || !page?.artifacts
        || page.status !== "success"
        || page.styleConsistency !== "accepted") {
        throw new Error("slide regeneration requires one accepted authenticated normalized page under the approved Style Lock");
      }
      const { readOwnedRegularFile } = await import("../project/safe-file.js");
      const normalized = await readOwnedRegularFile(valid.root, page.artifacts.normalized.path);
      const { replaceRegeneratedSlideShapeTree } = await import("../deck-revisions/edit-slide.js");
      await replaceRegeneratedSlideShapeTree({
        root: valid.root,
        currentRevisionId: current.revisionId,
        sessionId: candidate.sessionId,
        candidatePath: candidate.absolutePath,
        slideId: valid.route.slideId,
        normalizedImage: normalized,
        normalizedImageSha256: page.artifacts.normalized.sha256,
      });
    } else {
      if (!valid.conversionRoot) throw new Error("editable Agent routes require an authenticated editable conversion root");
      const { authenticateProjectEditableConversion } = await import("./adapter.js");
      let authenticated = await authenticateProjectEditableConversion({
        projectRoot: valid.root,
        conversionRoot: valid.conversionRoot,
        slideId: valid.route.slideId,
      });
      if (valid.route.route === "activate-editable") {
        const { activateEditableSlideInDeck } = await import("../deck-revisions/activate-slide.js");
        const activated = await activateEditableSlideInDeck({
          projectRoot: valid.root,
          candidatePath: candidate.absolutePath,
          slideIndex: target.position,
          slideId: valid.route.slideId,
          conversionRoot: valid.conversionRoot,
        });
        authenticated = activated.authenticatedConversion;
      }
      if (valid.route.operations.length > 0) {
        const { editActualSlideObjects } = await import("../deck-revisions/edit-slide.js");
        await editActualSlideObjects({
          root: valid.root,
          currentRevisionId: current.revisionId,
          sessionId: candidate.sessionId,
          candidatePath: candidate.absolutePath,
          slideId: valid.route.slideId,
          manifest: authenticated.manifest,
          operations: valid.route.operations,
        });
      }
    }
    return beginAgentCandidateConfirmation({
      root: valid.root,
      sessionId: candidate.sessionId,
      slideId: valid.route.slideId,
    });
  } catch (error: unknown) {
    try {
      const session = await readDeckEditSession(valid.root, candidate.sessionId);
      if (session.state === "prepared") {
        await rejectDeckCandidate(valid.root, {
          sessionId: candidate.sessionId,
          mode: "agent",
          requiredState: "prepared",
        });
      }
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "Agent deck edit failed and its candidate session could not be rejected");
    }
    throw error;
  }
}
