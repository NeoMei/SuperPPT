import {
  sha256Evidence,
  validateCurrentPresentationBinding,
  validateExecutionGateEvidence,
  validateOrdinaryGateEvidence,
} from "../project/evidence.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import type { Artifact, ProjectManifest } from "../project/schemas.js";

const ORDINARY_GATES = [
  "outline",
  "slide-specs",
  "style-sample",
  "generation-authorization",
  "deck-review",
] as const;
const EXECUTION_GATES = ["style-sample-generation"] as const;

async function validatedGateEvidence(
  root: string,
  manifest: ProjectManifest,
  gate: ProjectManifest["gates"][number],
): Promise<{ artifacts: Record<string, Buffer>; presentation?: Parameters<typeof validateCurrentPresentationBinding>[1] }> {
  if (gate.gate === "style-sample-generation") {
    const evidence = await validateExecutionGateEvidence(root, manifest, gate);
    return { artifacts: evidence.artifacts };
  }
  const evidence = await validateOrdinaryGateEvidence(root, manifest, gate);
  return { artifacts: evidence.artifacts, presentation: evidence.descriptor.presentation };
}

function artifactReferences(manifest: ProjectManifest): Artifact[] {
  return [
    manifest.brief,
    manifest.outline,
    manifest.style,
    ...manifest.slides.flatMap((slide) => [
      slide.image,
      slide.editable,
      slide.finalRender,
    ]),
    ...Object.values(manifest.exports),
  ].filter((artifact): artifact is Artifact => artifact !== null);
}

export async function assertCurrentRevisionPlanningEvidence(
  root: string,
  manifest: ProjectManifest,
): Promise<void> {
  try {
    for (const gateName of [...ORDINARY_GATES, ...EXECUTION_GATES]) {
      const gate = [...manifest.gates].reverse().find((candidate) =>
        candidate.gate === gateName
        && candidate.revisionId === manifest.currentRevision.id
      );
      if (!gate) continue;
      const evidence = await validatedGateEvidence(root, manifest, gate);
      for (const [path, expected] of Object.entries(gate.artifactHashes)) {
        if (sha256Evidence(await readOwnedRegularFile(root, path)) !== expected) {
          throw new Error(`ordinary gate artifact changed: ${path}`);
        }
      }
      if (evidence.presentation) await validateCurrentPresentationBinding(root, evidence.presentation);
    }
  } catch (error: unknown) {
    throw new Error("ordinary planning gate evidence is not current", { cause: error });
  }
}

export async function assertManifestArtifactReferences(
  root: string,
  manifest: ProjectManifest,
  projectedBytes: ReadonlyMap<string, Buffer> = new Map(),
): Promise<void> {
  const revisionIds = new Set(manifest.revisions.map((revision) => revision.id));
  try {
    for (const artifact of artifactReferences(manifest)) {
      if (!revisionIds.has(artifact.revisionId)) {
        throw new Error(`artifact references an unknown revision: ${artifact.path}`);
      }
      const bytes = projectedBytes.get(artifact.path)
        ?? await readOwnedRegularFile(root, artifact.path);
      if (sha256Evidence(bytes) !== artifact.sha256) {
        throw new Error(`artifact hash mismatch: ${artifact.path}`);
      }
    }
  } catch (error: unknown) {
    throw new Error("manifest Artifact reference is not current", { cause: error });
  }
}

export async function authenticatedPlanningArtifacts(
  root: string,
  manifest: ProjectManifest,
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  try {
    for (const gateName of [...ORDINARY_GATES, ...EXECUTION_GATES]) {
      const gate = [...manifest.gates].reverse().find((candidate) =>
        candidate.gate === gateName
        && candidate.revisionId === manifest.currentRevision.id
      );
      if (!gate) continue;
      const evidence = await validatedGateEvidence(root, manifest, gate);
      for (const [path, bytes] of Object.entries(evidence.artifacts)) {
        const prior = result.get(path);
        if (prior && !prior.equals(bytes)) {
          throw new Error(`authenticated planning snapshots disagree: ${path}`);
        }
        result.set(path, bytes);
      }
    }
    return result;
  } catch (error: unknown) {
    throw new Error("rollback planning artifact evidence is invalid", { cause: error });
  }
}
