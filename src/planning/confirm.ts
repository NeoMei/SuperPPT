import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import {
  addDescriptorIntegrity,
  GateSnapshotDescriptorSchema,
  type PresentationBinding,
  sha256Evidence,
  snapshotManifestEvidenceHash,
  validateOrdinaryGateEvidence,
} from "../project/evidence.js";
import { withPlanningLock, type ProjectLockOptions } from "../project/lock.js";
import { promoteExclusive } from "../project/promotion.js";
import { localProjectPath, readOwnedRegularFile, type SafeReadOperations } from "../project/safe-file.js";
import type { ProjectManifest } from "../project/schemas.js";
import { readProject, updateProject } from "../project/store.js";
import { loadValidatedOutline, loadValidatedPlan } from "./load.js";
import {
  requireCurrentDeckReviewPresentation,
  requireCurrentGenerationPlanPresentation,
  requireCurrentOutlinePresentation,
  requireCurrentPlanPresentation,
  requireCurrentStylePresentation,
} from "./views.js";
import {
  STYLE_SAMPLE_ARTIFACTS,
  validateCanonicalStyleSample,
  type StyleSampleArtifacts,
} from "../styles/sample-contract.js";

export type OrdinaryGate =
  | "outline"
  | "slide-specs"
  | "style-sample"
  | "generation-authorization"
  | "deck-review";
export type ExecutionGate = "style-sample-generation";
export type ConditionalGate = "revision-impact" | "slide-preview";
export type ProjectGate = OrdinaryGate | ExecutionGate | ConditionalGate;
export type PlanningGate = OrdinaryGate;
export type ApprovalCheckpoint = "snapshot-published" | "manifest-published";
export type ApprovalOptions = {
  operations?: {
    checkpoint?: (step: ApprovalCheckpoint) => Promise<void> | void;
    afterArtifactOpened?: (path: string) => Promise<void> | void;
  };
  lock?: ProjectLockOptions;
};
export type GateSnapshot = {
  manifest: ProjectManifest;
  artifacts: Record<string, Buffer>;
  snapshotPath: string;
};

export const previousOrdinaryGate: Record<OrdinaryGate, OrdinaryGate | null> = {
  outline: null,
  "slide-specs": "outline",
  "style-sample": "slide-specs",
  "generation-authorization": "style-sample",
  "deck-review": "generation-authorization",
};
export { STYLE_SAMPLE_ARTIFACTS } from "../styles/sample-contract.js";

export function toPortableProjectPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertOrdinaryGate(gate: string): asserts gate is OrdinaryGate {
  if (!(gate in previousOrdinaryGate)) throw new Error(`invalid planning gate: ${gate}`);
}

function approvalOptions(value: ApprovalOptions | undefined): ApprovalOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid approval options");
  if (Object.keys(value).some((key) => !["operations", "lock"].includes(key))) throw new Error("invalid approval options");
  if (value.operations && (
    typeof value.operations !== "object"
    || Object.keys(value.operations).some((key) => !["checkpoint", "afterArtifactOpened"].includes(key))
    || (value.operations.checkpoint !== undefined && typeof value.operations.checkpoint !== "function")
    || (value.operations.afterArtifactOpened !== undefined && typeof value.operations.afterArtifactOpened !== "function")
  )) throw new Error("invalid approval options");
  if (value.lock && (
    typeof value.lock !== "object"
    || Object.keys(value.lock).some((key) => !["staleAfterMs", "waitTimeoutMs", "retryMs"].includes(key))
    || Object.values(value.lock).some((item) => item !== undefined && (typeof item !== "number" || item < 0))
  )) throw new Error("invalid approval options");
  return value;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe revision snapshot directory: ${path}`);
}

async function ensureDirectoryTree(root: string, projectPath: string): Promise<string> {
  let cursor = await realpath(root);
  for (const component of localProjectPath(projectPath).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    await ensureDirectory(cursor);
  }
  return cursor;
}

function hashArtifacts(artifacts: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(Object.entries(artifacts).map(([path, bytes]) => [toPortableProjectPath(path), sha256Evidence(bytes)]));
}

async function gateArtifacts(
  root: string,
  gate: OrdinaryGate,
  operations: SafeReadOperations,
): Promise<Record<string, Buffer>> {
  if (gate === "outline") return (await loadValidatedOutline(root, operations)).artifacts;
  if (gate === "slide-specs") {
    const all = (await loadValidatedPlan(root, operations)).artifacts;
    return Object.fromEntries(Object.entries(all).filter(([path]) => path !== "brief.json"));
  }
  if (gate === "generation-authorization") return {
    "generation/authorization-plan.json": await readOwnedRegularFile(root, "generation/authorization-plan.json", operations),
  };
  if (gate === "deck-review") return Object.fromEntries(await Promise.all([
    "output/candidates/current/review.json",
    "output/candidates/current/montage.jpg",
  ].map(async (path) => [path, await readOwnedRegularFile(root, path, operations)])));
  const values = Object.fromEntries(await Promise.all(STYLE_SAMPLE_ARTIFACTS.map(async (path) => [
    path,
    await readOwnedRegularFile(root, path, operations),
  ]))) as StyleSampleArtifacts;
  await validateCanonicalStyleSample(root, values);
  return values;
}

async function currentPresentation(
  root: string,
  gate: OrdinaryGate,
  hashes: Record<string, string>,
): Promise<PresentationBinding> {
  if (gate === "style-sample") return requireCurrentStylePresentation(root, hashes);
  if (gate === "generation-authorization") return requireCurrentGenerationPlanPresentation(root, hashes);
  if (gate === "deck-review") return requireCurrentDeckReviewPresentation(root, hashes);
  if (gate === "slide-specs") return requireCurrentPlanPresentation(root, hashes);
  try {
    return await requireCurrentOutlinePresentation(root, hashes);
  } catch {
    return requireCurrentPlanPresentation(root, hashes);
  }
}

async function gateCurrentWithManifest(
  root: string,
  gate: OrdinaryGate,
  manifest: ProjectManifest,
): Promise<boolean> {
  const required = previousOrdinaryGate[gate];
  if (required && !await gateCurrentWithManifest(root, required, manifest)) return false;
  const approved = [...manifest.gates].reverse().find((item) => item.gate === gate);
  if (!approved || Object.keys(approved.artifactHashes).length === 0) return false;
  try {
    const evidence = await validateOrdinaryGateEvidence(root, manifest, approved);
    for (const [path, expected] of Object.entries(approved.artifactHashes)) {
      if (sha256Evidence(await readOwnedRegularFile(root, path)) !== expected) return false;
    }
    return sameJson(
      await currentPresentation(root, gate, approved.artifactHashes),
      evidence.descriptor.presentation,
    );
  } catch {
    return false;
  }
}

async function publishSnapshot(
  root: string,
  gate: OrdinaryGate,
  approvalId: string,
  snapshotPath: string,
  manifest: ProjectManifest,
  artifacts: Record<string, Buffer>,
  presentation: PresentationBinding,
): Promise<void> {
  const parentPath = dirname(snapshotPath).split(sep).join("/");
  const parent = await ensureDirectoryTree(root, parentPath);
  const staging = join(parent, `.${gate}-${randomUUID()}.staging`);
  await mkdir(staging, { mode: 0o700 });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const hashes = hashArtifacts(artifacts);
  const descriptor = GateSnapshotDescriptorSchema.parse(addDescriptorIntegrity({
    schemaVersion: 1 as const,
    projectId: manifest.projectId,
    gate,
    revisionId: manifest.currentRevision.id,
    approvalId,
    snapshotPath,
    manifestSha256: sha256Evidence(manifestBytes),
    artifactHashes: hashes,
    artifactSizes: Object.fromEntries(Object.entries(artifacts).map(([path, bytes]) => [path, bytes.length])),
    presentation,
  }));
  const directories = new Set<string>([staging]);
  await writeDurableExclusive(join(staging, "superppt.json"), manifestBytes);
  await writeDurableExclusive(join(staging, "snapshot.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  for (const [projectPath, bytes] of Object.entries(artifacts)) {
    const destination = join(staging, "artifacts", localProjectPath(projectPath));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let cursor = dirname(destination);
    while (cursor.startsWith(staging) && cursor !== staging) {
      directories.add(cursor);
      cursor = dirname(cursor);
    }
    await writeDurableExclusive(destination, bytes);
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
  await syncDirectory(parent);
  await promoteExclusive(staging, join(root, localProjectPath(snapshotPath)));
  await syncDirectory(parent);
}

export async function assertGateCurrent(root: string, gate: PlanningGate): Promise<boolean> {
  assertOrdinaryGate(gate);
  return gateCurrentWithManifest(root, gate, await readProject(root));
}

export async function approveGate(
  root: string,
  gate: PlanningGate,
  rawOptions?: ApprovalOptions,
): Promise<void> {
  assertOrdinaryGate(gate);
  const options = approvalOptions(rawOptions);
  await withPlanningLock(root, async (canonicalRoot) => {
    await updateProject(canonicalRoot, async (manifest) => {
      const required = previousOrdinaryGate[gate];
      if (required && !await gateCurrentWithManifest(canonicalRoot, required, manifest)) {
        throw new Error(`${required} gate must be current`);
      }
      const artifacts = await gateArtifacts(canonicalRoot, gate, {
        afterOpen: options.operations?.afterArtifactOpened,
      });
      const hashes = hashArtifacts(artifacts);
      const presentation = await currentPresentation(canonicalRoot, gate, hashes);
      if (required && !await gateCurrentWithManifest(canonicalRoot, required, manifest)) {
        throw new Error(`${required} gate must be current`);
      }
      const approvalId = randomUUID();
      const snapshotPath = toPortableProjectPath(join(
        "revisions",
        manifest.currentRevision.id,
        "gates",
        `${gate}-${approvalId}`,
      ));
      const gateRecord: ProjectManifest["gates"][number] = {
        gate,
        revisionId: manifest.currentRevision.id,
        approvalId,
        artifactHashes: hashes,
        snapshotPath,
        presentation,
        confirmedAt: new Date().toISOString(),
      };
      const provisional: ProjectManifest = {
        ...manifest,
        gates: [...manifest.gates, gateRecord],
      };
      const nextGate = {
        ...gateRecord,
        snapshotManifestSha256: snapshotManifestEvidenceHash(provisional, approvalId),
      };
      const next: ProjectManifest = {
        ...manifest,
        gates: [...manifest.gates, nextGate],
      };
      await publishSnapshot(canonicalRoot, gate, approvalId, snapshotPath, next, artifacts, presentation);
      await options.operations?.checkpoint?.("snapshot-published");
      if (required && !await gateCurrentWithManifest(canonicalRoot, required, manifest)) {
        throw new Error(`${required} gate must be current`);
      }
      const current = hashArtifacts(await gateArtifacts(canonicalRoot, gate, {}));
      if (!sameJson(current, hashes)) throw new Error(`${gate} gate artifacts changed during approval`);
      if (!sameJson(await currentPresentation(canonicalRoot, gate, hashes), presentation)) {
        throw new Error(`${gate} presentation changed during approval`);
      }
      return next;
    });
    await options.operations?.checkpoint?.("manifest-published");
  }, options.lock);
}

export async function readGateSnapshot(root: string, gate: PlanningGate): Promise<GateSnapshot> {
  assertOrdinaryGate(gate);
  const manifest = await readProject(root);
  const approved = [...manifest.gates].reverse().find((item) => item.gate === gate);
  if (!approved) throw new Error(`${gate} gate has no revision snapshot`);
  try {
    const evidence = await validateOrdinaryGateEvidence(root, manifest, approved);
    return { manifest: evidence.manifest, artifacts: evidence.artifacts, snapshotPath: approved.snapshotPath! };
  } catch (error: unknown) {
    throw new Error("snapshot descriptor or tree is invalid", { cause: error });
  }
}

export async function approveExecutionGate(
  root: string,
  gate: ExecutionGate,
  evidencePath: string,
): Promise<void> {
  if (gate !== "style-sample-generation" || evidencePath !== "style/sample/generation-plan.json") {
    throw new Error("invalid execution authorization");
  }
  await withPlanningLock(root, async (canonicalRoot) => {
    await updateProject(canonicalRoot, async (manifest) => {
      const evidence = await readOwnedRegularFile(canonicalRoot, evidencePath);
      return {
        ...manifest,
        gates: [...manifest.gates, {
          gate,
          revisionId: manifest.currentRevision.id,
          artifactHashes: { [evidencePath]: sha256Evidence(evidence) },
          confirmedAt: new Date().toISOString(),
        }],
      };
    });
  });
}
