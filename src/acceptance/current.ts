import { createHash } from "node:crypto";
import { posix } from "node:path";

import { AttemptLedgerSchema } from "../generation/schemas.js";
import {
  validateCurrentPresentationBinding,
  validateOrdinaryGateEvidence,
} from "../project/evidence.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import type { ProjectManifest } from "../project/schemas.js";
import type { Acceptance } from "./schema.js";

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateAcceptanceManifestBinding(
  root: string,
  manifest: ProjectManifest,
  acceptance: Acceptance,
): Promise<void> {
  if (acceptance.projectId !== manifest.projectId || acceptance.revisionId !== manifest.currentRevision.id) {
    throw new Error("acceptance evidence is not current");
  }
  const gateKinds = ["outline", "slide-specs", "style-sample"] as const;
  const gateRecords = gateKinds.map((kind) => [...manifest.gates].reverse().find((gate) => gate.gate === kind));
  if (
    gateRecords.some((gate) => !gate || gate.revisionId !== manifest.currentRevision.id)
    || !sameJson(acceptance.gates, {
      outline: gateRecords[0]?.revisionId,
      slideSpecs: gateRecords[1]?.revisionId,
      styleSample: gateRecords[2]?.revisionId,
    })
  ) throw new Error("acceptance evidence is not current");
  for (const gate of gateRecords) {
    const evidence = await validateOrdinaryGateEvidence(root, manifest, gate!);
    for (const [path, expectedSha256] of Object.entries(gate!.artifactHashes)) {
      if (createHash("sha256").update(await readOwnedRegularFile(root, path)).digest("hex") !== expectedSha256) {
        throw new Error("acceptance gate evidence is not current");
      }
    }
    await validateCurrentPresentationBinding(root, evidence.descriptor.presentation);
  }

  const slides = [...manifest.slides].sort((left, right) => left.order - right.order);
  if (slides.length !== acceptance.slides.length) throw new Error("acceptance evidence is not current");
  const editablePageIds: string[] = [];
  const providerIds = new Set<string>();
  for (const [index, evidence] of acceptance.slides.entries()) {
    const slide = slides[index]!;
    const mode = slide.status === "editable" ? "editable" : "image";
    const finalRender = slide.finalRender ?? (slide.status === "ready" ? slide.image : null);
    if (evidence.mode !== mode) throw new Error("acceptance slide mode is not current");
    if (
      !finalRender
      || finalRender.revisionId !== manifest.currentRevision.id
      || evidence.id !== slide.id
      || evidence.order !== slide.order
      || evidence.finalRenderSha256 !== finalRender.sha256
      || createHash("sha256").update(await readOwnedRegularFile(root, finalRender.path)).digest("hex") !== finalRender.sha256
    ) throw new Error("acceptance evidence is not current");
    if (mode === "editable") editablePageIds.push(slide.id);
    const image = slide.image;
    if (!image || image.revisionId !== manifest.currentRevision.id) throw new Error("acceptance provider evidence is not current");
    const ledgerPath = posix.join(posix.dirname(image.path), "ledger.json");
    const ledger = AttemptLedgerSchema.parse(JSON.parse((await readOwnedRegularFile(root, ledgerPath)).toString("utf8")));
    if (
      ledger.slideId !== slide.id
      || ledger.revisionId !== manifest.currentRevision.id
      || ledger.outcome !== "accepted"
      || ledger.output !== image.path
      || ledger.outputSha256 !== image.sha256
    ) throw new Error("acceptance provider evidence is not current");
    providerIds.add(ledger.providerId);
  }
  if (!sameJson(acceptance.editablePageIds, editablePageIds)) throw new Error("acceptance editable page identity is not current");
  if (providerIds.size !== 1 || !providerIds.has(acceptance.providerId)) throw new Error("acceptance provider evidence is not current");

  for (const kind of ["pptx", "pdf", "montage"] as const) {
    const artifact = manifest.exports[kind];
    const evidence = acceptance.exports[kind];
    if (!artifact || evidence.path !== artifact.path || evidence.sha256 !== artifact.sha256) {
      throw new Error("acceptance evidence is not current");
    }
    if (createHash("sha256").update(await readOwnedRegularFile(root, artifact.path)).digest("hex") !== artifact.sha256) {
      throw new Error("acceptance evidence is not current");
    }
  }
}
