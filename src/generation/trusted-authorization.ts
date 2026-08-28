import { constants } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { GateSnapshotDescriptor } from "../project/evidence.js";
import { syncDirectory } from "../project/durable.js";
import { readProject } from "../project/store.js";
import type { ProjectManifest } from "../project/schemas.js";
import {
  GenerationAuthorizationPlanSchema,
  canonicalContractFile,
  type GenerationAuthorizationPlan,
} from "./job-schemas.js";

const SHA256 = /^[a-f0-9]{64}$/;
const KEY_BYTES = 32;
const KEY_FILE = "hmac.key";
const RECORDS_DIRECTORY = "records";

const AuthorizationTrustBindingSchema = z.object({
  recordId: z.string().uuid(),
  recordSha256: z.string().regex(SHA256),
}).strict();

const SignedRecordBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-authorization-approval"),
  recordId: z.string().uuid(),
  projectId: z.string().uuid(),
  approvalId: z.string().uuid(),
  revisionId: z.string().uuid(),
  authorizationPlanSha256: z.string().regex(SHA256),
  callBudget: z.number().int().positive(),
  orderedCalls: z.array(z.object({
    slideId: z.string().uuid(),
    order: z.number().int().nonnegative(),
    promptSha256: z.string().regex(SHA256).nullable(),
  }).strict()).min(1),
  gateSnapshot: z.object({
    path: z.string().startsWith("revisions/"),
    snapshotManifestSha256: z.string().regex(SHA256),
    descriptorSha256: z.string().regex(SHA256),
    manifestSha256: z.string().regex(SHA256),
  }).strict(),
  confirmedAt: z.string().datetime(),
}).strict();

const SignedRecordSchema = SignedRecordBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

type SignedRecordBase = z.infer<typeof SignedRecordBaseSchema>;
type SignedRecord = z.infer<typeof SignedRecordSchema>;
export type GenerationAuthorizationTrustBinding = z.infer<typeof AuthorizationTrustBindingSchema>;

type AuthorizationGateBinding = {
  gate: "generation-authorization" | "style-sample-generation";
  approvalId: string;
  snapshotPath: string;
  snapshotManifestSha256: string;
  authorizationPlanSha256: string;
};

type TestTrustConfiguration = {
  root: string;
  deterministicKeySeed: string;
};

const testConfigurations = new Map<string, TestTrustConfiguration>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRecord(value: SignedRecord): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function signaturePayload(value: SignedRecordBase): string {
  return JSON.stringify(value);
}

function defaultTrustRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "SuperPPT", "authorization-trust-v1");
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(homedir(), "AppData", "Local"), "SuperPPT", "authorization-trust-v1");
  }
  const state = process.env.XDG_STATE_HOME;
  return join(state && isAbsolute(state) ? state : join(homedir(), ".local", "state"), "superppt", "authorization-trust-v1");
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  return realpath(projectRoot);
}

export async function configureGenerationAuthorizationTrustForTests(
  projectRoot: string,
  configuration: TestTrustConfiguration,
): Promise<void> {
  if (!configuration.deterministicKeySeed) throw new Error("test authorization trust key seed must not be empty");
  const canonical = await canonicalProjectRoot(projectRoot);
  testConfigurations.set(canonical, {
    root: resolve(configuration.root),
    deterministicKeySeed: configuration.deterministicKeySeed,
  });
}

async function trustConfiguration(projectRoot: string): Promise<TestTrustConfiguration> {
  const canonical = await canonicalProjectRoot(projectRoot);
  const configured = testConfigurations.get(canonical);
  return configured ?? { root: defaultTrustRoot(), deterministicKeySeed: "" };
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`trusted authorization path has a symbolic link ancestor: ${cursor}`);
    if (!info.isDirectory() && cursor !== absolute) {
      throw new Error(`trusted authorization path has a non-directory ancestor: ${cursor}`);
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(absolute);
  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`trusted authorization directory is unsafe: ${cursor}`);
      }
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await lstat(directory);
      if (concurrent.isSymbolicLink() || !concurrent.isDirectory()) {
        throw new Error(`trusted authorization directory is unsafe: ${directory}`);
      }
    }
    await syncDirectory(dirname(directory));
  }
  await assertNoSymlinkComponents(absolute);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(absolute) !== absolute) {
    throw new Error("trusted authorization directory is unsafe");
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error("trusted authorization directory must have mode 0700");
  }
  return absolute;
}

async function trustRoot(projectRoot: string): Promise<{ root: string; deterministicKeySeed: string }> {
  const canonicalProject = await canonicalProjectRoot(projectRoot);
  const configuration = await trustConfiguration(canonicalProject);
  const configuredRoot = resolve(configuration.root);
  const difference = relative(canonicalProject, configuredRoot);
  if (!difference || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))) {
    throw new Error("trusted authorization store must be outside the project root");
  }
  const root = await ensurePrivateDirectory(configuredRoot);
  await ensurePrivateDirectory(join(root, RECORDS_DIRECTORY));
  return { root, deterministicKeySeed: configuration.deterministicKeySeed };
}

async function readPrivateRegularFile(path: string, label: string): Promise<Buffer> {
  await assertNoSymlinkComponents(path);
  const before = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label} is missing`, { cause: error });
  });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular file`);
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 0600`);
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(path);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) throw new Error(`${label} changed while reading`);
    await assertNoSymlinkComponents(path);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivateExclusive(path: string, bytes: Buffer | string): Promise<boolean> {
  await assertNoSymlinkComponents(dirname(path));
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(bytes, typeof bytes === "string" ? "utf8" : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  await assertNoSymlinkComponents(path);
  return true;
}

async function readWithConcurrentCreateRetry(path: string, label: string): Promise<Buffer> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readPrivateRegularFile(path, label);
    } catch (error: unknown) {
      last = error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  throw last;
}

async function createOrReadKey(projectRoot: string): Promise<{ storeRoot: string; key: Buffer }> {
  const store = await trustRoot(projectRoot);
  const path = join(store.root, KEY_FILE);
  const generated = store.deterministicKeySeed
    ? createHash("sha256").update(store.deterministicKeySeed).digest()
    : randomBytes(KEY_BYTES);
  await writePrivateExclusive(path, generated);
  const key = await readWithConcurrentCreateRetry(path, "trusted authorization HMAC key");
  if (key.length !== KEY_BYTES) throw new Error("trusted authorization HMAC key has invalid length");
  return { storeRoot: store.root, key };
}

async function readKey(projectRoot: string): Promise<{ storeRoot: string; key: Buffer }> {
  const store = await trustRoot(projectRoot);
  const key = await readPrivateRegularFile(join(store.root, KEY_FILE), "trusted authorization HMAC key");
  if (key.length !== KEY_BYTES) throw new Error("trusted authorization HMAC key has invalid length");
  return { storeRoot: store.root, key };
}

function authorizationSummary(bytes: Buffer): {
  callBudget: number;
  orderedCalls: SignedRecordBase["orderedCalls"];
} {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error: unknown) {
    throw new Error("generation authorization artifact is invalid", { cause: error });
  }
  const raw = z.object({
    callBudget: z.number().int().positive(),
    pages: z.array(z.object({
      slideId: z.string().uuid(),
      order: z.number().int().nonnegative(),
      promptSha256: z.string().regex(SHA256).optional(),
    }).passthrough()).optional(),
    pageIds: z.array(z.string().uuid()).optional(),
  }).passthrough().parse(value);
  const orderedCalls = raw.pages?.map((page) => ({
    slideId: page.slideId,
    order: page.order,
    promptSha256: page.promptSha256 ?? null,
  })) ?? raw.pageIds?.map((slideId, order) => ({ slideId, order, promptSha256: null })) ?? [];
  if (orderedCalls.length === 0) throw new Error("generation authorization artifact has no ordered calls");
  for (let index = 1; index < orderedCalls.length; index += 1) {
    if (orderedCalls[index]!.order <= orderedCalls[index - 1]!.order) {
      throw new Error("generation authorization artifact pages are not in strictly increasing order");
    }
  }
  return { callBudget: raw.callBudget, orderedCalls };
}

function signedRecord(
  key: Buffer,
  base: SignedRecordBase,
): SignedRecord {
  const signature = createHmac("sha256", key).update(signaturePayload(base)).digest("hex");
  return SignedRecordSchema.parse({ ...base, signature });
}

function assertSignature(key: Buffer, record: SignedRecord): void {
  const { signature, ...base } = record;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key).update(signaturePayload(SignedRecordBaseSchema.parse(base))).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted authorization record signature is invalid");
  }
}

function expectedRecord(
  manifest: ProjectManifest,
  gate: ProjectManifest["gates"][number],
  planBytes: Buffer,
  descriptor: GateSnapshotDescriptor,
): SignedRecordBase {
  if (
    gate.gate !== "generation-authorization"
    || !gate.approvalId
    || !gate.snapshotPath
    || !gate.snapshotManifestSha256
    || gate.artifactHashes["generation/authorization-plan.json"] !== sha256(planBytes)
  ) throw new Error("generation authorization gate cannot be externally trusted");
  const summary = authorizationSummary(planBytes);
  return SignedRecordBaseSchema.parse({
    schemaVersion: 1,
    kind: "generation-authorization-approval",
    recordId: gate.approvalId,
    projectId: manifest.projectId,
    approvalId: gate.approvalId,
    revisionId: gate.revisionId,
    authorizationPlanSha256: sha256(planBytes),
    callBudget: summary.callBudget,
    orderedCalls: summary.orderedCalls,
    gateSnapshot: {
      path: gate.snapshotPath,
      snapshotManifestSha256: gate.snapshotManifestSha256,
      descriptorSha256: descriptor.descriptorSha256,
      manifestSha256: descriptor.manifestSha256,
    },
    confirmedAt: gate.confirmedAt,
  });
}

export async function appendTrustedGenerationAuthorizationRecord(
  projectRoot: string,
  input: {
    manifest: ProjectManifest;
    gate: ProjectManifest["gates"][number];
    planBytes: Buffer;
    descriptor: GateSnapshotDescriptor;
  },
): Promise<GenerationAuthorizationTrustBinding> {
  const project = await readProject(projectRoot);
  if (project.projectId !== input.manifest.projectId) {
    throw new Error("trusted authorization project identity changed during approval");
  }
  const { storeRoot, key } = await createOrReadKey(projectRoot);
  const record = signedRecord(key, expectedRecord(input.manifest, input.gate, input.planBytes, input.descriptor));
  const bytes = canonicalRecord(record);
  const path = join(storeRoot, RECORDS_DIRECTORY, `${record.recordId}.json`);
  if (!await writePrivateExclusive(path, bytes)) {
    const existing = await readWithConcurrentCreateRetry(path, "trusted authorization record");
    if (!existing.equals(Buffer.from(bytes))) throw new Error("trusted authorization record conflicts with immutable approval evidence");
    const parsed = SignedRecordSchema.parse(JSON.parse(existing.toString("utf8")));
    assertSignature(key, parsed);
  }
  return AuthorizationTrustBindingSchema.parse({ recordId: record.recordId, recordSha256: sha256(bytes) });
}

async function readTrustedRecord(
  projectRoot: string,
  binding: GenerationAuthorizationTrustBinding,
): Promise<SignedRecord> {
  const validBinding = AuthorizationTrustBindingSchema.parse(binding);
  const { storeRoot, key } = await readKey(projectRoot);
  const bytes = await readPrivateRegularFile(
    join(storeRoot, RECORDS_DIRECTORY, `${validBinding.recordId}.json`),
    "trusted authorization record",
  );
  if (sha256(bytes) !== validBinding.recordSha256) throw new Error("trusted authorization record digest is invalid");
  let record: SignedRecord;
  try {
    record = SignedRecordSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalRecord(record) !== bytes.toString("utf8")) throw new Error("record is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted authorization record is invalid", { cause: error });
  }
  assertSignature(key, record);
  return record;
}

function exactRecordForPlan(
  plan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
  record: SignedRecord,
  descriptor?: GateSnapshotDescriptor,
): void {
  const expectedCalls = plan.pages.map(({ slideId, order, promptSha256 }) => ({ slideId, order, promptSha256 }));
  if (
    gate.gate !== "generation-authorization"
    || record.recordId !== gate.approvalId
    || record.approvalId !== gate.approvalId
    || record.projectId !== plan.projectId
    || record.revisionId !== plan.projectRevisionId
    || record.authorizationPlanSha256 !== gate.authorizationPlanSha256
    || record.authorizationPlanSha256 !== sha256(canonicalContractFile(plan))
    || record.callBudget !== plan.callBudget
    || JSON.stringify(record.orderedCalls) !== JSON.stringify(expectedCalls)
    || record.gateSnapshot.path !== gate.snapshotPath
    || record.gateSnapshot.snapshotManifestSha256 !== gate.snapshotManifestSha256
    || (descriptor !== undefined && (
      record.gateSnapshot.descriptorSha256 !== descriptor.descriptorSha256
      || record.gateSnapshot.manifestSha256 !== descriptor.manifestSha256
    ))
  ) throw new Error("trusted authorization record does not bind the exact project approval");
}

export async function assertTrustedGenerationAuthorizationRecord(
  projectRoot: string,
  rawBinding: GenerationAuthorizationTrustBinding,
  rawPlan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
  descriptor?: GateSnapshotDescriptor,
): Promise<void> {
  const plan = GenerationAuthorizationPlanSchema.parse(rawPlan);
  const project = await readProject(projectRoot);
  if (project.projectId !== plan.projectId) throw new Error("trusted authorization record belongs to a different project");
  const manifestGate = project.gates.find((candidate) => candidate.approvalId === gate.approvalId);
  if (
    !manifestGate
    || manifestGate.gate !== "generation-authorization"
    || manifestGate.revisionId !== plan.projectRevisionId
    || manifestGate.snapshotPath !== gate.snapshotPath
    || manifestGate.snapshotManifestSha256 !== gate.snapshotManifestSha256
  ) throw new Error("trusted authorization record has no exact manifest gate");
  const record = await readTrustedRecord(projectRoot, rawBinding);
  exactRecordForPlan(plan, gate, record, descriptor);
}

export async function trustedGenerationAuthorizationForGate(
  projectRoot: string,
  plan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
  descriptor: GateSnapshotDescriptor,
): Promise<GenerationAuthorizationTrustBinding> {
  const binding = AuthorizationTrustBindingSchema.parse({
    recordId: gate.approvalId,
    recordSha256: sha256(await readPrivateRegularFile(
      join((await trustRoot(projectRoot)).root, RECORDS_DIRECTORY, `${gate.approvalId}.json`),
      "trusted authorization record",
    )),
  });
  await assertTrustedGenerationAuthorizationRecord(projectRoot, binding, plan, gate, descriptor);
  return binding;
}
