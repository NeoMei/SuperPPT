import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

import { localProjectPath, readOwnedRegularFile } from "./safe-file.js";
import { ProjectManifestSchema, type ProjectManifest } from "./schemas.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HashesSchema = z.record(z.string(), HashSchema);
const SizesSchema = z.record(z.string(), z.number().int().nonnegative());
const OrdinaryGateSchema = z.enum([
  "outline",
  "slide-specs",
  "style-sample",
  "generation-authorization",
  "deck-review",
]);
const ExecutionGateSchema = z.literal("style-sample-generation");

export const PresentationBindingSchema = z.object({
  kind: z.enum(["planning-views", "style-sample", "generation-plan", "deck-review"]),
  publicationPath: z.union([
    z.string().startsWith("revisions/"),
    z.literal("generation/authorization-plan.json"),
    z.literal("output/candidates/current/review.json"),
  ]),
  descriptorSha256: HashSchema,
}).strict();

const PlanPublicationBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("planning-views"),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  publicationId: z.string().uuid(),
  publicationPath: z.string().startsWith("revisions/"),
  outlineSlideIds: z.array(z.string().uuid()).min(3).max(60),
  sourceHashes: HashesSchema,
  viewHashes: HashesSchema,
  publishedAt: z.string().datetime(),
}).strict();

const StylePublicationBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("style-sample"),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  publicationId: z.string().uuid(),
  publicationPath: z.string().startsWith("revisions/"),
  styleId: z.string().regex(/^[a-z0-9-]+$/),
  representativeSlideId: z.string().uuid(),
  sourceHashes: HashesSchema,
  publishedAt: z.string().datetime(),
}).strict();

export const PlanPublicationDescriptorSchema = PlanPublicationBaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();
export const StylePublicationDescriptorSchema = StylePublicationBaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

const SnapshotBaseSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  gate: OrdinaryGateSchema,
  revisionId: z.string().uuid(),
  approvalId: z.string().uuid(),
  snapshotPath: z.string().startsWith("revisions/"),
  manifestSha256: HashSchema,
  artifactHashes: HashesSchema,
  artifactSizes: SizesSchema,
  presentation: PresentationBindingSchema,
}).strict();

export const GateSnapshotDescriptorSchema = SnapshotBaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

const ExecutionSnapshotBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("execution-gate-snapshot"),
  projectId: z.string().uuid(),
  gate: ExecutionGateSchema,
  revisionId: z.string().uuid(),
  approvalId: z.string().uuid(),
  snapshotPath: z.string().startsWith("revisions/"),
  manifestSha256: HashSchema,
  artifactHashes: HashesSchema,
  artifactSizes: SizesSchema,
}).strict();

export const ExecutionGateSnapshotDescriptorSchema = ExecutionSnapshotBaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

export type PlanPublicationDescriptor = z.infer<typeof PlanPublicationDescriptorSchema>;
export type StylePublicationDescriptor = z.infer<typeof StylePublicationDescriptorSchema>;
export type GateSnapshotDescriptor = z.infer<typeof GateSnapshotDescriptorSchema>;
export type ExecutionGateSnapshotDescriptor = z.infer<typeof ExecutionGateSnapshotDescriptorSchema>;
export type PresentationBinding = z.infer<typeof PresentationBindingSchema>;
export type OrdinaryGate = z.infer<typeof OrdinaryGateSchema>;

export function sha256Evidence(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotManifestEvidenceHash(
  manifest: ProjectManifest,
  approvalId: string,
): string {
  const normalized = structuredClone(manifest);
  const gate = normalized.gates.find((item) => item.approvalId === approvalId);
  if (!gate) throw new Error("snapshot manifest does not contain its approval identity");
  delete gate.snapshotManifestSha256;
  return sha256Evidence(`${JSON.stringify(normalized, null, 2)}\n`);
}

export function addDescriptorIntegrity<T extends Record<string, unknown>>(
  value: T,
): T & { descriptorSha256: string } {
  return { ...value, descriptorSha256: sha256Evidence(JSON.stringify(value)) };
}

function verifyIntegrity(value: object): void {
  const { descriptorSha256, ...base } = value as Record<string, unknown>;
  if (descriptorSha256 !== sha256Evidence(JSON.stringify(base))) {
    throw new Error("descriptor integrity check failed");
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function listTree(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`evidence tree contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`evidence tree contains a non-file: ${path}`);
    }
  }
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("evidence tree must be a regular directory");
  await visit(root);
  return result.sort();
}

async function verifyHashedFiles(
  root: string,
  publicationPath: string,
  prefix: string,
  hashes: Record<string, string>,
): Promise<void> {
  for (const [path, expected] of Object.entries(hashes)) {
    const bytes = await readOwnedRegularFile(root, `${publicationPath}/${prefix}${path}`);
    if (sha256Evidence(bytes) !== expected) throw new Error(`publication hash mismatch: ${path}`);
  }
}

function outlineIds(bytes: Buffer): string[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error: unknown) {
    throw new Error("publication outline source is invalid", { cause: error });
  }
  const parsed = z.object({
    schemaVersion: z.literal(1),
    slides: z.array(z.object({ id: z.string().uuid() }).passthrough()).min(3).max(60),
  }).passthrough().parse(value);
  const ids = parsed.slides.map((slide) => slide.id);
  if (new Set(ids).size !== ids.length) throw new Error("publication outline IDs must be unique");
  return ids;
}

export async function validatePlanPublicationEvidence(
  root: string,
  publicationPath: string,
): Promise<PlanPublicationDescriptor> {
  let descriptor: PlanPublicationDescriptor;
  try {
    descriptor = PlanPublicationDescriptorSchema.parse(JSON.parse(
      (await readOwnedRegularFile(root, `${publicationPath}/publication.json`)).toString("utf8"),
    ));
  } catch (error: unknown) {
    throw new Error("planning publication descriptor is invalid", { cause: error });
  }
  verifyIntegrity(descriptor);
  if (descriptor.publicationPath !== publicationPath) throw new Error("planning publication path identity mismatch");
  const outlineBytes = await readOwnedRegularFile(root, `${publicationPath}/sources/outline.json`);
  const ids = outlineIds(outlineBytes);
  if (!sameJson(ids, descriptor.outlineSlideIds)) throw new Error("planning publication outline identity mismatch");
  const outlineSourceKeys = [
    "brief.json",
    "outline.json",
  ].sort();
  const outlineViewKeys = [
    "brief.md",
    "outline.md",
  ].sort();
  const completeSourceKeys = [...outlineSourceKeys, ...ids.map((id) => `slides/${id}/spec.json`)].sort();
  const completeViewKeys = [...outlineViewKeys, ...ids.map((id) => `slides/${id}/spec.md`)].sort();
  const actualSourceKeys = Object.keys(descriptor.sourceHashes).sort();
  const actualViewKeys = Object.keys(descriptor.viewHashes).sort();
  const outlineOnly = sameJson(actualSourceKeys, outlineSourceKeys) && sameJson(actualViewKeys, outlineViewKeys);
  const complete = sameJson(actualSourceKeys, completeSourceKeys) && sameJson(actualViewKeys, completeViewKeys);
  if (!outlineOnly && !complete) {
    throw new Error("planning publication source coverage is incomplete");
  }
  await verifyHashedFiles(root, publicationPath, "sources/", descriptor.sourceHashes);
  await verifyHashedFiles(root, publicationPath, "", descriptor.viewHashes);
  const expectedTree = [
    "publication.json",
    ...actualSourceKeys.map((path) => `sources/${path}`),
    ...actualViewKeys,
  ].sort();
  const treeRoot = join(await realpath(root), localProjectPath(publicationPath));
  if (!sameJson(await listTree(treeRoot), expectedTree)) throw new Error("planning publication tree coverage is incomplete");
  return descriptor;
}

export async function validateStylePublicationEvidence(
  root: string,
  publicationPath: string,
): Promise<StylePublicationDescriptor> {
  let descriptor: StylePublicationDescriptor;
  try {
    descriptor = StylePublicationDescriptorSchema.parse(JSON.parse(
      (await readOwnedRegularFile(root, `${publicationPath}/publication.json`)).toString("utf8"),
    ));
  } catch (error: unknown) {
    throw new Error("style publication descriptor is invalid", { cause: error });
  }
  verifyIntegrity(descriptor);
  if (descriptor.publicationPath !== publicationPath) throw new Error("style publication path identity mismatch");
  const keys = [
    "style/selection.json",
    "style/sample/director.json",
    "style/sample/prompt.txt",
    "style/sample/sample.png",
    "style/sample/ledger.json",
  ];
  if (!sameJson(Object.keys(descriptor.sourceHashes).sort(), [...keys].sort())) {
    throw new Error("style publication source coverage is incomplete");
  }
  await verifyHashedFiles(root, publicationPath, "sources/", descriptor.sourceHashes);
  const expectedTree = ["publication.json", ...keys.map((path) => `sources/${path}`)].sort();
  const treeRoot = join(await realpath(root), localProjectPath(publicationPath));
  if (!sameJson(await listTree(treeRoot), expectedTree)) throw new Error("style publication tree coverage is incomplete");
  return descriptor;
}

export async function validateCurrentPresentationBinding(
  root: string,
  binding: PresentationBinding,
): Promise<void> {
  if (binding.kind === "generation-plan" || binding.kind === "deck-review") {
    const pointerPath = binding.kind === "generation-plan"
      ? "generation/authorization-plan.json"
      : "output/candidates/current/review.json";
    if (binding.publicationPath !== pointerPath) {
      throw new Error("current presentation pointer does not match gate evidence");
    }
    const pointer = await readOwnedRegularFile(root, pointerPath);
    if (sha256Evidence(pointer) !== binding.descriptorSha256) {
      throw new Error("current presentation pointer does not match gate evidence");
    }
    return;
  }
  const pointerPaths = binding.kind === "planning-views"
    ? ["outline-views.json", "planning-views.json"]
    : ["style-sample.json"];
  const pointers = await Promise.all(pointerPaths.map(async (pointerPath) => {
    try {
      const bytes = await readOwnedRegularFile(root, pointerPath);
      return binding.kind === "planning-views"
        ? PlanPublicationDescriptorSchema.parse(JSON.parse(bytes.toString("utf8")))
        : StylePublicationDescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      return null;
    }
  }));
  const pointer = pointers.find((candidate) => candidate
    && candidate.publicationPath === binding.publicationPath
    && candidate.descriptorSha256 === binding.descriptorSha256);
  const immutable = binding.kind === "planning-views"
    ? await validatePlanPublicationEvidence(root, binding.publicationPath)
    : await validateStylePublicationEvidence(root, binding.publicationPath);
  if (
    !pointer
    ||
    !sameJson(pointer, immutable)
    || pointer.publicationPath !== binding.publicationPath
    || pointer.descriptorSha256 !== binding.descriptorSha256
  ) throw new Error("current presentation pointer does not match gate evidence");
}

function assertExactGateKeys(
  gate: OrdinaryGate,
  hashes: Record<string, string>,
  artifacts?: Record<string, Buffer>,
): void {
  const keys = Object.keys(hashes).sort();
  if (gate === "outline") {
    if (!sameJson(keys, ["brief.json", "outline.json"])) throw new Error("ordinary gate evidence has invalid outline keys");
    return;
  }
  if (gate === "style-sample") {
    const expected = [
      "style/sample/director.json",
      "style/sample/ledger.json",
      "style/sample/prompt.txt",
      "style/sample/sample.png",
      "style/selection.json",
    ];
    if (!sameJson(keys, expected)) throw new Error("ordinary gate evidence has invalid style keys");
    return;
  }
  if (gate === "generation-authorization") {
    if (!sameJson(keys, ["generation/authorization-plan.json"])) {
      throw new Error("ordinary gate evidence has invalid generation authorization keys");
    }
    return;
  }
  if (gate === "deck-review") {
    if (!sameJson(keys, ["output/candidates/current/montage.jpg", "output/candidates/current/review.json"])) {
      throw new Error("ordinary gate evidence has invalid deck review keys");
    }
    return;
  }
  if (!artifacts?.["outline.json"]) {
    if (!keys.includes("outline.json") || keys.some((key) => key !== "outline.json" && !/^slides\/[0-9a-f-]{36}\/spec\.json$/.test(key))) {
      throw new Error("ordinary gate evidence has invalid slide-spec keys");
    }
    return;
  }
  const expected = ["outline.json", ...outlineIds(artifacts["outline.json"]).map((id) => `slides/${id}/spec.json`)].sort();
  if (!sameJson(keys, expected)) throw new Error("ordinary gate evidence has invalid slide-spec coverage");
}

export async function validateOrdinaryGateEvidence(
  root: string,
  project: ProjectManifest,
  gateRecord: ProjectManifest["gates"][number],
): Promise<{
  descriptor: GateSnapshotDescriptor;
  manifest: ProjectManifest;
  artifacts: Record<string, Buffer>;
}> {
  const gate = OrdinaryGateSchema.safeParse(gateRecord.gate);
  if (!gate.success) throw new Error("ordinary gate evidence validator received a non-ordinary gate");
  assertExactGateKeys(gate.data, gateRecord.artifactHashes);
  if (!gateRecord.snapshotPath) throw new Error("ordinary gate evidence requires a snapshot path");
  const match = new RegExp(`^revisions/([0-9a-f-]{36})/gates/${gate.data}-([0-9a-f-]{36})$`).exec(gateRecord.snapshotPath);
  if (!match || !UUID.test(match[1]!) || !UUID.test(match[2]!)) {
    throw new Error("ordinary gate evidence has an untrusted snapshot path");
  }
  let descriptor: GateSnapshotDescriptor;
  try {
    descriptor = GateSnapshotDescriptorSchema.parse(JSON.parse(
      (await readOwnedRegularFile(root, `${gateRecord.snapshotPath}/snapshot.json`)).toString("utf8"),
    ));
  } catch (error: unknown) {
    throw new Error("snapshot descriptor is invalid", { cause: error });
  }
  verifyIntegrity(descriptor);
  if (
    descriptor.projectId !== project.projectId
    || descriptor.gate !== gate.data
    || descriptor.revisionId !== gateRecord.revisionId
    || descriptor.revisionId !== match[1]
    || descriptor.approvalId !== match[2]
    || gateRecord.approvalId !== match[2]
    || descriptor.snapshotPath !== gateRecord.snapshotPath
    || !sameJson(descriptor.artifactHashes, gateRecord.artifactHashes)
    || !sameJson(Object.keys(descriptor.artifactSizes).sort(), Object.keys(gateRecord.artifactHashes).sort())
    || !gateRecord.snapshotManifestSha256
    || !gateRecord.presentation
    || !sameJson(descriptor.presentation, gateRecord.presentation)
  ) throw new Error("snapshot descriptor identity mismatch");

  const manifestBytes = await readOwnedRegularFile(root, `${gateRecord.snapshotPath}/superppt.json`);
  if (sha256Evidence(manifestBytes) !== descriptor.manifestSha256) throw new Error("snapshot manifest hash mismatch");
  const snapshotManifest = ProjectManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (
    snapshotManifest.projectId !== project.projectId
    || snapshotManifest.currentRevision.id !== descriptor.revisionId
    || !sameJson(snapshotManifest.gates.at(-1), gateRecord)
  ) throw new Error("snapshot manifest identity mismatch");
  if (snapshotManifestEvidenceHash(snapshotManifest, descriptor.approvalId) !== gateRecord.snapshotManifestSha256) {
    throw new Error("snapshot manifest evidence hash mismatch");
  }

  const artifacts: Record<string, Buffer> = {};
  for (const [path, expected] of Object.entries(gateRecord.artifactHashes)) {
    const bytes = await readOwnedRegularFile(root, `${gateRecord.snapshotPath}/artifacts/${path}`);
    if (sha256Evidence(bytes) !== expected || bytes.length !== descriptor.artifactSizes[path]) {
      throw new Error(`snapshot artifact integrity mismatch: ${path}`);
    }
    artifacts[path] = bytes;
  }
  assertExactGateKeys(gate.data, gateRecord.artifactHashes, artifacts);
  const expectedTree = [
    "snapshot.json",
    "superppt.json",
    ...Object.keys(gateRecord.artifactHashes).map((path) => `artifacts/${path}`),
  ].sort();
  const treeRoot = join(await realpath(root), localProjectPath(gateRecord.snapshotPath));
  if (!sameJson(await listTree(treeRoot), expectedTree)) throw new Error("snapshot tree coverage is invalid");

  if (descriptor.presentation.kind === "generation-plan" || descriptor.presentation.kind === "deck-review") {
    const expectedKind = gate.data === "generation-authorization" ? "generation-plan" : "deck-review";
    if (descriptor.presentation.kind !== expectedKind) {
      throw new Error("snapshot presentation kind mismatch");
    }
    const presentationArtifact = descriptor.presentation.kind === "generation-plan"
      ? "generation/authorization-plan.json"
      : "output/candidates/current/review.json";
    if (descriptor.presentation.descriptorSha256 !== gateRecord.artifactHashes[presentationArtifact]) {
      throw new Error("snapshot presentation artifact mismatch");
    }
  } else {
    const publication = descriptor.presentation.kind === "planning-views"
      ? await validatePlanPublicationEvidence(root, descriptor.presentation.publicationPath)
      : await validateStylePublicationEvidence(root, descriptor.presentation.publicationPath);
    if (publication.descriptorSha256 !== descriptor.presentation.descriptorSha256) {
      throw new Error("snapshot presentation identity mismatch");
    }
    if (publication.projectId !== descriptor.projectId || publication.revisionId !== descriptor.revisionId) {
      throw new Error("snapshot presentation project or revision mismatch");
    }
    if ((gate.data === "style-sample") !== (publication.kind === "style-sample")) {
      throw new Error("snapshot presentation kind mismatch");
    }
    const presented = publication.sourceHashes;
    for (const [path, expected] of Object.entries(gateRecord.artifactHashes)) {
      if (presented[path] !== expected) throw new Error("snapshot presentation artifact mismatch");
    }
  }
  return { descriptor, manifest: snapshotManifest, artifacts };
}

export async function validateExecutionGateEvidence(
  root: string,
  project: ProjectManifest,
  gateRecord: ProjectManifest["gates"][number],
): Promise<{
  descriptor: ExecutionGateSnapshotDescriptor;
  manifest: ProjectManifest;
  artifacts: Record<string, Buffer>;
}> {
  if (gateRecord.gate !== "style-sample-generation") {
    throw new Error("execution gate evidence validator received a non-execution gate");
  }
  const path = "style/sample/generation-plan.json";
  if (
    Object.keys(gateRecord.artifactHashes).length !== 1
    || !gateRecord.approvalId
    || !gateRecord.snapshotPath
    || !gateRecord.snapshotManifestSha256
    || gateRecord.presentation
    || !gateRecord.artifactHashes[path]
  ) throw new Error("execution gate evidence has incomplete identity");
  const expectedPath = `revisions/${gateRecord.revisionId}/execution-gates/style-sample-generation-${gateRecord.approvalId}`;
  if (gateRecord.snapshotPath !== expectedPath) {
    throw new Error("execution gate evidence has an untrusted snapshot path");
  }
  let descriptor: ExecutionGateSnapshotDescriptor;
  try {
    descriptor = ExecutionGateSnapshotDescriptorSchema.parse(JSON.parse(
      (await readOwnedRegularFile(root, `${gateRecord.snapshotPath}/snapshot.json`)).toString("utf8"),
    ));
  } catch (error: unknown) {
    throw new Error("execution snapshot descriptor is invalid", { cause: error });
  }
  verifyIntegrity(descriptor);
  if (
    descriptor.projectId !== project.projectId
    || descriptor.gate !== gateRecord.gate
    || descriptor.revisionId !== gateRecord.revisionId
    || descriptor.approvalId !== gateRecord.approvalId
    || descriptor.snapshotPath !== gateRecord.snapshotPath
    || !sameJson(descriptor.artifactHashes, gateRecord.artifactHashes)
    || !sameJson(Object.keys(descriptor.artifactSizes).sort(), Object.keys(gateRecord.artifactHashes).sort())
  ) throw new Error("execution snapshot descriptor identity mismatch");

  const manifestBytes = await readOwnedRegularFile(root, `${gateRecord.snapshotPath}/superppt.json`);
  if (sha256Evidence(manifestBytes) !== descriptor.manifestSha256) {
    throw new Error("execution snapshot manifest hash mismatch");
  }
  const snapshotManifest = ProjectManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (
    snapshotManifest.projectId !== project.projectId
    || snapshotManifest.currentRevision.id !== descriptor.revisionId
    || !sameJson(snapshotManifest.gates.at(-1), gateRecord)
    || snapshotManifestEvidenceHash(snapshotManifest, descriptor.approvalId) !== gateRecord.snapshotManifestSha256
  ) throw new Error("execution snapshot manifest identity mismatch");

  const artifacts: Record<string, Buffer> = {};
  for (const [artifactPath, expected] of Object.entries(gateRecord.artifactHashes)) {
    const bytes = await readOwnedRegularFile(root, `${gateRecord.snapshotPath}/artifacts/${artifactPath}`);
    if (sha256Evidence(bytes) !== expected || bytes.length !== descriptor.artifactSizes[artifactPath]) {
      throw new Error(`execution snapshot artifact integrity mismatch: ${artifactPath}`);
    }
    artifacts[artifactPath] = bytes;
  }
  const expectedTree = [
    "snapshot.json",
    "superppt.json",
    ...Object.keys(gateRecord.artifactHashes).map((artifactPath) => `artifacts/${artifactPath}`),
  ].sort();
  const treeRoot = join(await realpath(root), localProjectPath(gateRecord.snapshotPath));
  if (!sameJson(await listTree(treeRoot), expectedTree)) {
    throw new Error("execution snapshot tree coverage is invalid");
  }
  return { descriptor, manifest: snapshotManifest, artifacts };
}
