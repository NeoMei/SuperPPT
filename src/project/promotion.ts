import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AcceptanceSchema,
  DeckReviewActionEvidenceSchema,
  DeckReviewActionRequestSchema,
  DeckReviewDescriptorSchema,
  type DeckReviewActionEvidence,
  type DeckReviewActionRequest,
  type DeckReviewDescriptor,
} from "../acceptance/schema.js";
import { bindConfirmedDeckReview } from "../acceptance/build.js";
import {
  candidatePromotionSupport,
  type AssembleProjectResult,
  type CandidatePromotionOperations,
  type OutputArtifacts,
} from "../deck/assemble.js";
import { approveDeckReviewActionGate, assertGateCurrent } from "../planning/confirm.js";
import { syncDirectory, writeDurableExclusive } from "./durable.js";
import { addDescriptorIntegrity, sha256Evidence } from "./evidence.js";
import { promoteExclusive } from "./exclusive.js";
import { withPlanningLock, withProjectLease } from "./lock.js";
import { readOwnedRegularFile, readRegularFileNoFollow } from "./safe-file.js";
import { type Artifact, type ProjectManifest } from "./schemas.js";
import { readProject, updateProject } from "./store.js";

export { promoteExclusive } from "./exclusive.js";

export type DeckReviewActionOutcome =
  | { action: "confirm-delivery"; stage: "assembling"; delivery: AssembleProjectResult }
  | { action: "edit-page"; stage: "revising"; delivery: null }
  | { action: "return-upstream"; stage: "generation-authorization"; delivery: null };

const {
  OutputMarkerSchema,
  canonicalArtifactRefs,
  ensureOwnedDirectory,
  publishOutputManifest,
  readDeckCandidate,
  sameGenerationAuthorization,
  validateOwnedOutput,
} = candidatePromotionSupport;

async function writeReplacementBytes(path: string, bytes: Buffer): Promise<void> {
  const staging = `${path}.${randomUUID()}.staging`;
  await writeDurableExclusive(staging, bytes);
  await rename(staging, path);
  await syncDirectory(dirname(path));
}

function verifiedDeckReviewDescriptor(bytes: Buffer): DeckReviewDescriptor {
  let descriptor: DeckReviewDescriptor;
  try {
    descriptor = DeckReviewDescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("deck-review descriptor is invalid", { cause: error });
  }
  const { descriptorSha256, ...base } = descriptor;
  if (descriptorSha256 !== sha256Evidence(JSON.stringify(base))) {
    throw new Error("deck-review descriptor integrity check failed");
  }
  return descriptor;
}

function verifiedDeckReviewAction(bytes: Buffer): DeckReviewActionEvidence {
  let action: DeckReviewActionEvidence;
  try {
    action = DeckReviewActionEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("deck-review action evidence is invalid", { cause: error });
  }
  const { actionEvidenceSha256, ...base } = action;
  if (actionEvidenceSha256 !== sha256Evidence(JSON.stringify(base))) {
    throw new Error("deck-review action integrity check failed");
  }
  return action;
}

async function readCurrentReviewPresentation(root: string): Promise<{
  review: DeckReviewDescriptor;
  reviewBytes: Buffer;
  montageBytes: Buffer;
}> {
  const reviewBytes = await readOwnedRegularFile(root, "output/candidates/current/review.json");
  const review = verifiedDeckReviewDescriptor(reviewBytes);
  const montageBytes = await readOwnedRegularFile(root, "output/candidates/current/montage.jpg");
  if (sha256Evidence(montageBytes) !== review.artifacts.montage.sha256) {
    throw new Error("current deck-review montage does not bind the authenticated descriptor");
  }
  return { review, reviewBytes, montageBytes };
}

function assertReviewCandidateBinding(
  review: DeckReviewDescriptor,
  candidateId: string,
  manifest: ProjectManifest,
  candidate: Awaited<ReturnType<typeof readDeckCandidate>>,
): void {
  if (
    review.candidateId !== candidateId
    || review.projectId !== manifest.projectId
    || review.projectRevisionId !== manifest.currentRevision.id
    || review.deckRevision !== candidate.marker.revisionNumber
    || review.candidatePath !== `output/candidates/${candidateId}`
    || review.candidateMarkerSha256 !== sha256Evidence(candidate.markerBytes)
    || review.projectBindingSha256 !== candidate.marker.projectBindingSha256
    || !sameGenerationAuthorization(review.generationAuthorization, candidate.marker.generationAuthorization)
    || JSON.stringify(review.artifacts) !== JSON.stringify(Object.fromEntries(
      (Object.keys(candidate.marker.artifacts) as Array<keyof OutputArtifacts>).map((kind) => [kind, {
        path: candidate.marker.artifacts[kind].path,
        sha256: candidate.marker.artifacts[kind].sha256,
      }]),
    ))
  ) throw new Error("deck-review descriptor does not bind the exact candidate");
}

export async function publishDeckReview(root: string, candidateId: string): Promise<DeckReviewDescriptor> {
  return withPlanningLock(root, async (canonicalRoot) => {
    const manifest = await readProject(canonicalRoot);
    if (!await assertGateCurrent(canonicalRoot, "generation-authorization")) {
      throw new Error("current generation-authorization gate is required before deck review");
    }
    const candidate = await readDeckCandidate(canonicalRoot, candidateId, manifest);
    const candidatePath = `output/candidates/${candidateId}`;
    const currentRoot = await ensureOwnedDirectory(canonicalRoot, "output/candidates/current");
    const existing = await readdir(currentRoot, { withFileTypes: true });
    if (existing.some((entry) => !["action.json", "montage.jpg", "review.json"].includes(entry.name)
      || !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error("deck-review publication directory is unsafe");
    }
    const descriptor = DeckReviewDescriptorSchema.parse(addDescriptorIntegrity({
      schemaVersion: 1 as const,
      kind: "deck-review" as const,
      candidateId,
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      deckRevision: candidate.marker.revisionNumber,
      candidatePath,
      candidateMarkerSha256: sha256Evidence(candidate.markerBytes),
      projectBindingSha256: candidate.marker.projectBindingSha256,
      generationAuthorization: candidate.marker.generationAuthorization,
      artifacts: Object.fromEntries((Object.keys(candidate.marker.artifacts) as Array<keyof OutputArtifacts>).map((kind) => [kind, {
        path: candidate.marker.artifacts[kind].path,
        sha256: candidate.marker.artifacts[kind].sha256,
      }])),
      actions: ["edit-page", "return-upstream", "confirm-delivery"] as const,
      createdAt: new Date().toISOString(),
    }));
    const montage = await readOwnedRegularFile(canonicalRoot, candidate.marker.artifacts.montage.path);
    if (sha256Evidence(montage) !== candidate.marker.artifacts.montage.sha256) {
      throw new Error("candidate montage changed during deck-review publication");
    }
    if (existing.some((entry) => entry.name === "action.json")) await unlink(join(currentRoot, "action.json"));
    await writeReplacementBytes(join(currentRoot, "montage.jpg"), montage);
    await writeReplacementBytes(join(currentRoot, "review.json"), Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`));
    await updateProject(canonicalRoot, (current) => {
      if (JSON.stringify(current) !== JSON.stringify(manifest)) {
        throw new Error("project revision changed during deck-review publication");
      }
      return { ...current, stage: "deck-review" };
    });
    await readCurrentReviewPresentation(canonicalRoot);
    return descriptor;
  });
}

async function recordDeckReviewAction(root: string, request: DeckReviewActionRequest): Promise<void> {
  await withPlanningLock(root, async (canonicalRoot) => {
    const manifest = await readProject(canonicalRoot);
    if (manifest.stage !== "deck-review") throw new Error("deck-review action requires the current review stage");
    const { review } = await readCurrentReviewPresentation(canonicalRoot);
    if (review.candidateId !== request.candidateId || review.descriptorSha256 !== request.descriptorSha256) {
      throw new Error("deck-review action does not bind the current descriptor and candidate");
    }
    const candidate = await readDeckCandidate(canonicalRoot, request.candidateId, manifest);
    assertReviewCandidateBinding(review, request.candidateId, manifest, candidate);
    const actionBase = {
      schemaVersion: 1 as const,
      kind: "deck-review-action" as const,
      actionId: randomUUID(),
      action: request.action,
      candidateId: request.candidateId,
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      reviewDescriptorSha256: review.descriptorSha256,
      presentedMontageSha256: review.artifacts.montage.sha256,
      actedAt: new Date().toISOString(),
    };
    const action = DeckReviewActionEvidenceSchema.parse({
      ...actionBase,
      actionEvidenceSha256: sha256Evidence(JSON.stringify(actionBase)),
    });
    await writeReplacementBytes(
      join(canonicalRoot, "output/candidates/current/action.json"),
      Buffer.from(`${JSON.stringify(action, null, 2)}\n`),
    );
    if (request.action !== "confirm-delivery") {
      await updateProject(canonicalRoot, (current) => {
        if (JSON.stringify(current) !== JSON.stringify(manifest)) {
          throw new Error("project revision changed during deck-review action");
        }
        return {
          ...current,
          stage: request.action === "return-upstream" ? "generation-authorization" : "revising",
        };
      });
    }
  });
}

export async function applyDeckReviewAction(
  root: string,
  rawRequest: DeckReviewActionRequest,
  operations: CandidatePromotionOperations = {},
): Promise<DeckReviewActionOutcome> {
  const request = DeckReviewActionRequestSchema.parse(rawRequest);
  await recordDeckReviewAction(root, request);
  if (request.action === "return-upstream") {
    return { action: request.action, stage: "generation-authorization", delivery: null };
  }
  if (request.action === "edit-page") {
    return { action: request.action, stage: "revising", delivery: null };
  }
  await approveDeckReviewActionGate(root);
  const delivery = await promoteApprovedCandidate(root, request.candidateId, operations);
  return { action: request.action, stage: "assembling", delivery };
}

export async function promoteApprovedCandidate(
  projectRoot: string,
  candidateId: string,
  operations: CandidatePromotionOperations = {},
): Promise<AssembleProjectResult> {
  return withProjectLease(projectRoot, "assembly", async (root) => {
    const manifest = await readProject(root);
    const { review, reviewBytes } = await readCurrentReviewPresentation(root);
    if (review.candidateId !== candidateId) throw new Error("candidate is not the current deck-review presentation");
    const actionBytes = await readOwnedRegularFile(root, "output/candidates/current/action.json");
    const action = verifiedDeckReviewAction(actionBytes);
    if (
      action.action !== "confirm-delivery"
      || action.candidateId !== candidateId
      || action.projectId !== manifest.projectId
      || action.projectRevisionId !== manifest.currentRevision.id
      || action.reviewDescriptorSha256 !== review.descriptorSha256
      || action.presentedMontageSha256 !== review.artifacts.montage.sha256
    ) throw new Error("authenticated confirm-delivery action does not bind the current deck-review");
    if (!await assertGateCurrent(root, "deck-review")) {
      throw new Error("current deck-review approval is required before candidate promotion");
    }
    const approved = [...manifest.gates].reverse().find((gate) => gate.gate === "deck-review");
    if (
      !approved?.presentation
      || approved.presentation.kind !== "deck-review"
      || approved.presentation.descriptorSha256 !== sha256Evidence(reviewBytes)
      || approved.artifactHashes["output/candidates/current/action.json"] !== sha256Evidence(actionBytes)
    ) throw new Error("deck-review approval does not bind the authenticated current action");
    const candidate = await readDeckCandidate(root, candidateId, manifest);
    assertReviewCandidateBinding(review, candidateId, manifest, candidate);

    const revisionsRoot = await ensureOwnedDirectory(root, "output/revisions");
    const destination = join(revisionsRoot, String(candidate.marker.revisionNumber));
    const expectedMarker = {
      markerVersion: 1 as const,
      appId: "superppt" as const,
      artifactKind: "image-deck" as const,
      candidateId,
      projectId: candidate.marker.projectId,
      revisionId: candidate.marker.projectRevisionId,
      revisionNumber: candidate.marker.revisionNumber,
      providerId: candidate.marker.providerId,
      projectBindingSha256: candidate.marker.projectBindingSha256,
      slides: candidate.marker.slides,
    };
    try {
      await lstat(destination);
      const recovered = await validateOwnedOutput(root, destination, expectedMarker, manifest);
      if (Object.values(manifest.exports).some((artifact) => artifact !== null)) {
        throw new Error("candidate promotion is a replay; formal revision already exists");
      }
      await publishOutputManifest(root, candidate.marker.projectRevisionId, recovered);
      await operations.checkpoint?.("manifest-updated");
      return {
        projectId: candidate.marker.projectId,
        revisionId: candidate.marker.projectRevisionId,
        revisionNumber: candidate.marker.revisionNumber,
        destination,
        recovered: true,
        artifacts: recovered.artifacts,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const staging = join(revisionsRoot, `.staging-${candidateId}-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    for (const [kind, name] of [["pptx", "deck.pptx"], ["pdf", "deck.pdf"], ["montage", "montage.jpg"]] as const) {
      const bytes = await readOwnedRegularFile(root, candidate.marker.artifacts[kind].path);
      if (sha256Evidence(bytes) !== candidate.marker.artifacts[kind].sha256) {
        throw new Error("candidate artifact changed during promotion");
      }
      await writeDurableExclusive(join(staging, name), bytes);
    }
    const refs = canonicalArtifactRefs(candidate.marker.revisionNumber);
    const acceptance = bindConfirmedDeckReview(AcceptanceSchema.parse({
      ...candidate.acceptance,
      exports: {
        pptx: { ...candidate.acceptance.exports.pptx, path: refs.pptx },
        pdf: { ...candidate.acceptance.exports.pdf, path: refs.pdf },
        montage: { ...candidate.acceptance.exports.montage, path: refs.montage },
      },
    }), action);
    await writeDurableExclusive(join(staging, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
    const evidence = async (kind: keyof OutputArtifacts, name: string): Promise<Artifact> => ({
      path: refs[kind],
      sha256: sha256Evidence(await readRegularFileNoFollow(join(staging, name))),
      revisionId: candidate.marker.projectRevisionId,
    });
    const artifacts: OutputArtifacts = {
      pptx: await evidence("pptx", "deck.pptx"),
      pdf: await evidence("pdf", "deck.pdf"),
      montage: await evidence("montage", "montage.jpg"),
      acceptance: await evidence("acceptance", "acceptance.json"),
    };
    const marker = OutputMarkerSchema.parse({ ...expectedMarker, artifacts });
    await writeDurableExclusive(join(staging, ".superppt-output.json"), `${JSON.stringify(marker, null, 2)}\n`);
    await syncDirectory(staging);
    await syncDirectory(revisionsRoot);
    const current = await readProject(root);
    await readCurrentReviewPresentation(root);
    if (
      JSON.stringify(current) !== JSON.stringify(manifest)
      || !await assertGateCurrent(root, "deck-review")
    ) throw new Error("project revision or authenticated deck-review approval changed during promotion");
    await promoteExclusive(staging, destination);
    await syncDirectory(revisionsRoot);
    await operations.checkpoint?.("output-promoted");
    const verified = await validateOwnedOutput(root, destination, expectedMarker);
    await publishOutputManifest(root, marker.revisionId, verified);
    await operations.checkpoint?.("manifest-updated");
    return {
      projectId: marker.projectId,
      revisionId: marker.revisionId,
      revisionNumber: marker.revisionNumber,
      destination,
      recovered: false,
      artifacts: verified.artifacts,
    };
  });
}
