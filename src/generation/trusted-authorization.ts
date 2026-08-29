import { constants } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { GateSnapshotDescriptor } from "../project/evidence.js";
import { syncDirectory } from "../project/durable.js";
import { promoteExclusive } from "../project/exclusive.js";
import { readProject } from "../project/store.js";
import type { ProjectManifest } from "../project/schemas.js";
import {
  CallLedgerEntrySchema,
  GenerationAuthorizationPlanSchema,
  canonicalContractFile,
  type CallLedgerEntry,
  type GenerationAuthorizationPlan,
  type ImageGenerationJob,
} from "./job-schemas.js";
import { appendPrivateInputLine } from "./private-input.js";
import { assertGenerationLeaseHeld, withGenerationLease } from "./lease.js";

const SHA256 = /^[a-f0-9]{64}$/;
const KEY_BYTES = 32;
const KEY_FILE = "hmac.key";
const RECORDS_DIRECTORY = "records";
const AUTHORIZATION_HEADS_DIRECTORY = "authorization-heads";
const HEADS_DIRECTORY = "heads";
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 16 * 1024;
const MAX_AUTHORIZATION_HEADS = 10_000;
const CALL_LEDGERS_DIRECTORY = "call-ledgers";
const EVENTS_DIRECTORY = "events";
const MAX_CALL_EVENT_BYTES = 16 * 1024;
const MAX_CALL_HEAD_BYTES = 16 * 1024;
const MAX_CALL_EVENTS = 100_000;
const CALL_LEDGER_PROJECT_PATH = join("generation", "call-ledger.jsonl");
const PROJECT_REGISTRATIONS_DIRECTORY = "project-registrations";
const PROJECT_REGISTRY_DIRECTORY = "project-registry";
const REGISTRY_STATES_DIRECTORY = "states";
const MAX_REGISTRATION_BYTES = 16 * 1024;
const MAX_REGISTRY_STATE_BYTES = 16 * 1024;
const MAX_REGISTRY_STATES = MAX_AUTHORIZATION_HEADS + MAX_CALL_EVENTS + 2;
const MAX_PROJECT_CALL_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_CALL_LEDGER_ENTRIES = MAX_CALL_EVENTS;

export type GenerationAuthorizationTrustCheckpoint =
  | "key-temp-synced"
  | "record-temp-synced"
  | "authorization-head-temp-synced"
  | "call-event-temp-synced"
  | "call-event-published"
  | "call-project-ledger-appended"
  | "call-head-temp-synced"
  | "call-head-published"
  | "registration-temp-synced"
  | "registry-state-temp-synced"
  | "registry-before-authorization-advance"
  | "registry-before-call-advance"
  | "authorization-head-directory-opened"
  | "call-head-directory-opened"
  | "call-event-directory-opened"
  | "call-recovery-before-project-append";

const AuthorizationTrustBindingSchema = z.object({
  recordId: z.string().uuid(),
  recordSha256: z.string().regex(SHA256),
}).strict();

const SignedRecordBaseSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("generation-authorization-approval"),
  recordId: z.string().uuid(),
  projectId: z.string().uuid(),
  approvalId: z.string().uuid(),
  sequence: z.number().int().positive(),
  predecessor: z.object({
    recordId: z.string().uuid(),
    recordSha256: z.string().regex(SHA256),
  }).strict().nullable(),
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

const AuthorizationHeadBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-authorization-head"),
  projectId: z.string().uuid(),
  sequence: z.number().int().positive(),
  recordId: z.string().uuid(),
  recordSha256: z.string().regex(SHA256),
  approvalId: z.string().uuid(),
  authorizationPlanSha256: z.string().regex(SHA256),
  predecessorHeadSha256: z.string().regex(SHA256).nullable(),
}).strict();

const AuthorizationHeadSchema = AuthorizationHeadBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const TrustedCallEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-call-ledger-event"),
  eventId: z.string().uuid(),
  projectId: z.string().uuid(),
  sequence: z.number().int().positive(),
  predecessor: z.object({
    eventId: z.string().uuid(),
    eventSha256: z.string().regex(SHA256),
  }).strict().nullable(),
  authorizationApprovalId: z.string().uuid(),
  authorizationDigest: z.string().regex(SHA256),
  authorizationTrust: AuthorizationTrustBindingSchema.nullable(),
  entry: CallLedgerEntrySchema,
}).strict();

const TrustedCallEventSchema = TrustedCallEventBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const TrustedCallHeadBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-call-ledger-head"),
  projectId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  event: z.object({
    eventId: z.string().uuid(),
    eventSha256: z.string().regex(SHA256),
  }).strict().nullable(),
  predecessorHeadSha256: z.string().regex(SHA256).nullable(),
}).strict().superRefine((head, context) => {
  if ((head.sequence === 0) !== (head.event === null)) {
    context.addIssue({ code: "custom", path: ["event"], message: "empty call head must be sequence zero" });
  }
  if ((head.sequence === 0) !== (head.predecessorHeadSha256 === null)) {
    context.addIssue({ code: "custom", path: ["predecessorHeadSha256"], message: "call head predecessor is invalid" });
  }
});

const TrustedCallHeadSchema = z.object({
  ...TrustedCallHeadBaseSchema.shape,
  signature: z.string().regex(SHA256),
}).strict();

const ProjectRegistrationBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-project-registration"),
  projectId: z.string().uuid(),
  registrationId: z.string().uuid(),
  registeredAt: z.string().datetime(),
}).strict();

const ProjectRegistrationSchema = ProjectRegistrationBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const HighWaterSchema = z.object({
  sequence: z.number().int().nonnegative(),
  headSha256: z.string().regex(SHA256),
}).strict();

const ProjectRegistryStateBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-project-high-water"),
  projectId: z.string().uuid(),
  registrationSha256: z.string().regex(SHA256),
  version: z.number().int().positive(),
  predecessorStateSha256: z.string().regex(SHA256).nullable(),
  authorization: HighWaterSchema.nullable(),
  calls: HighWaterSchema.nullable(),
}).strict();

const ProjectRegistryStateSchema = ProjectRegistryStateBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

type SignedRecordBase = z.infer<typeof SignedRecordBaseSchema>;
type SignedRecord = z.infer<typeof SignedRecordSchema>;
type AuthorizationHeadBase = z.infer<typeof AuthorizationHeadBaseSchema>;
type AuthorizationHead = z.infer<typeof AuthorizationHeadSchema>;
type TrustedCallEventBase = z.infer<typeof TrustedCallEventBaseSchema>;
type TrustedCallEvent = z.infer<typeof TrustedCallEventSchema>;
type TrustedCallHeadBase = z.infer<typeof TrustedCallHeadBaseSchema>;
type TrustedCallHead = z.infer<typeof TrustedCallHeadSchema>;
type ProjectRegistrationBase = z.infer<typeof ProjectRegistrationBaseSchema>;
type ProjectRegistration = z.infer<typeof ProjectRegistrationSchema>;
type ProjectRegistryStateBase = z.infer<typeof ProjectRegistryStateBaseSchema>;
type ProjectRegistryState = z.infer<typeof ProjectRegistryStateSchema>;
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
  operations?: {
    checkpoint?: (step: GenerationAuthorizationTrustCheckpoint) => Promise<void> | void;
    limits?: {
      authorizationHeads?: number;
      callHeads?: number;
      callEvents?: number;
      registryStates?: number;
      projectLedgerBytes?: number;
      projectLedgerEntries?: number;
    };
  };
};

const testConfigurations = new Map<string, TestTrustConfiguration>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRecord(value: SignedRecord): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalAuthorizationHead(value: AuthorizationHead): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalCallEvent(value: TrustedCallEvent): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalCallHead(value: TrustedCallHead): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalRegistration(value: ProjectRegistration): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalRegistryState(value: ProjectRegistryState): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function signaturePayload(value: SignedRecordBase): string {
  return JSON.stringify(value);
}

function authorizationHeadFilename(sequence: number): string {
  return `${String(sequence).padStart(16, "0")}.json`;
}

function callHeadFilename(sequence: number): string {
  return `${String(sequence).padStart(16, "0")}.json`;
}

function callEventFilename(sequence: number, eventId: string): string {
  return `${String(sequence).padStart(16, "0")}-${eventId}.json`;
}

function registryStateFilename(version: number): string {
  return `${String(version).padStart(16, "0")}.json`;
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
    operations: configuration.operations,
  });
}

async function trustConfiguration(projectRoot: string): Promise<TestTrustConfiguration> {
  const canonical = await canonicalProjectRoot(projectRoot);
  const configured = testConfigurations.get(canonical);
  if (configured) return configured;
  const environmentRoot = process.env.SUPERPPT_AUTHORIZATION_TRUST_ROOT;
  if (environmentRoot !== undefined) {
    if (!isAbsolute(environmentRoot)) throw new Error("SUPERPPT_AUTHORIZATION_TRUST_ROOT must be absolute");
    return { root: resolve(environmentRoot), deterministicKeySeed: "", operations: undefined };
  }
  return { root: defaultTrustRoot(), deterministicKeySeed: "", operations: undefined };
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

async function trustRoot(projectRoot: string): Promise<{
  root: string;
  deterministicKeySeed: string;
  operations: TestTrustConfiguration["operations"];
}> {
  const canonicalProject = await canonicalProjectRoot(projectRoot);
  const configuration = await trustConfiguration(canonicalProject);
  const configuredRoot = resolve(configuration.root);
  const difference = relative(canonicalProject, configuredRoot);
  if (!difference || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))) {
    throw new Error("trusted authorization store must be outside the project root");
  }
  const root = await ensurePrivateDirectory(configuredRoot);
  await ensurePrivateDirectory(join(root, RECORDS_DIRECTORY));
  return {
    root,
    deterministicKeySeed: configuration.deterministicKeySeed,
    operations: configuration.operations,
  };
}

async function readPrivateRegularFile(path: string, label: string, maximumBytes: number): Promise<Buffer> {
  await assertNoSymlinkComponents(path);
  const before = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label} is missing`, { cause: error });
  });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular file`);
  if (before.size > maximumBytes) throw new Error(`${label} size is too large`);
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 0600`);
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > maximumBytes
    ) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} ended before its authenticated size`);
      offset += bytesRead;
    }
    const openedAfter = await handle.stat();
    const after = await lstat(path);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
      || openedAfter.size !== opened.size
      || openedAfter.mtimeMs !== opened.mtimeMs
    ) throw new Error(`${label} changed while reading`);
    await assertNoSymlinkComponents(path);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function pathKind(path: string): Promise<"missing" | "directory" | "file" | "unsafe"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "unsafe";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "unsafe";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function readBoundedPrivateDirectory(
  path: string,
  label: string,
  maximumEntries: number,
  validateName: (name: string) => "include" | "ignore" | "reject",
  operations?: TestTrustConfiguration["operations"],
  checkpoint?: GenerationAuthorizationTrustCheckpoint,
): Promise<string[]> {
  await assertNoSymlinkComponents(path);
  const before = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label} is missing`, { cause: error });
  });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`${label} is unsafe`);
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must have mode 0700`);
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const directoryOnly = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while opening`);
    }
    if (checkpoint) await operations?.checkpoint?.(checkpoint);
    // Node's opendir cannot portably consume an already-open directory fd
    // (macOS exposes /dev/fd entries as non-directories). The held O_NOFOLLOW
    // descriptor anchors identity while opendir iterates; no names escape this
    // function until the descriptor and path identities are revalidated below.
    directory = await opendir(path);
    const names: string[] = [];
    let count = 0;
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      count += 1;
      if (count > maximumEntries) {
        const historyLabel = label.endsWith(" directory") ? label.slice(0, -" directory".length) : label;
        throw new Error(`${historyLabel} history is too large`);
      }
      const disposition = validateName(entry.name);
      if (disposition === "reject" || entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`${label} contains an unsafe entry`);
      }
      if (disposition === "include") names.push(entry.name);
    }
    const openedAfter = await handle.stat();
    const after = await lstat(path).catch((error: unknown) => {
      throw new Error(`${label} changed while reading`, { cause: error });
    });
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
    ) throw new Error(`${label} changed while reading`);
    await assertNoSymlinkComponents(path);
    return names;
  } finally {
    await directory?.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    });
    await handle.close();
  }
}

async function writePrivateExclusive(
  path: string,
  bytes: Buffer | string,
  checkpoint?: GenerationAuthorizationTrustCheckpoint,
  operations?: TestTrustConfiguration["operations"],
): Promise<boolean> {
  const parent = dirname(path);
  await assertNoSymlinkComponents(parent);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(bytes, typeof bytes === "string" ? "utf8" : undefined);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (checkpoint) await operations?.checkpoint?.(checkpoint);
    try {
      await promoteExclusive(temporary, path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await syncDirectory(parent);
    await assertNoSymlinkComponents(path);
    return true;
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function readWithConcurrentCreateRetry(path: string, label: string, maximumBytes: number): Promise<Buffer> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readPrivateRegularFile(path, label, maximumBytes);
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
  await writePrivateExclusive(path, generated, "key-temp-synced", store.operations);
  const key = await readWithConcurrentCreateRetry(path, "trusted authorization HMAC key", KEY_BYTES);
  if (key.length !== KEY_BYTES) throw new Error("trusted authorization HMAC key has invalid length");
  return { storeRoot: store.root, key };
}

async function readKey(projectRoot: string): Promise<{ storeRoot: string; key: Buffer }> {
  const store = await trustRoot(projectRoot);
  const key = await readPrivateRegularFile(join(store.root, KEY_FILE), "trusted authorization HMAC key", KEY_BYTES);
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

function signedAuthorizationHead(key: Buffer, base: AuthorizationHeadBase): AuthorizationHead {
  const parsed = AuthorizationHeadBaseSchema.parse(base);
  const signature = createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex");
  return AuthorizationHeadSchema.parse({ ...parsed, signature });
}

function assertAuthorizationHeadSignature(key: Buffer, head: AuthorizationHead): void {
  const { signature, ...base } = head;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(AuthorizationHeadBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted authorization head signature is invalid");
  }
}

function signedCallEvent(key: Buffer, base: TrustedCallEventBase): TrustedCallEvent {
  const parsed = TrustedCallEventBaseSchema.parse(base);
  const signature = createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex");
  return TrustedCallEventSchema.parse({ ...parsed, signature });
}

function assertCallEventSignature(key: Buffer, event: TrustedCallEvent): void {
  const { signature, ...base } = event;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(TrustedCallEventBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted call ledger event signature is invalid");
  }
}

function signedCallHead(key: Buffer, base: TrustedCallHeadBase): TrustedCallHead {
  const parsed = TrustedCallHeadBaseSchema.parse(base);
  const signature = createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex");
  return TrustedCallHeadSchema.parse({ ...parsed, signature });
}

function assertCallHeadSignature(key: Buffer, head: TrustedCallHead): void {
  const { signature, ...base } = head;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(TrustedCallHeadBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted call ledger head signature is invalid");
  }
}

function signedRegistration(key: Buffer, base: ProjectRegistrationBase): ProjectRegistration {
  const parsed = ProjectRegistrationBaseSchema.parse(base);
  return ProjectRegistrationSchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertRegistrationSignature(key: Buffer, registration: ProjectRegistration): void {
  const { signature, ...base } = registration;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(ProjectRegistrationBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted project registration signature is invalid");
  }
}

function signedRegistryState(key: Buffer, base: ProjectRegistryStateBase): ProjectRegistryState {
  const parsed = ProjectRegistryStateBaseSchema.parse(base);
  return ProjectRegistryStateSchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertRegistryStateSignature(key: Buffer, state: ProjectRegistryState): void {
  const { signature, ...base } = state;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(ProjectRegistryStateBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted project registry state signature is invalid");
  }
}

type ProjectHighWater = z.infer<typeof HighWaterSchema>;

type ProjectRegistrySnapshot = {
  registration: ProjectRegistration;
  registrationSha256: string;
  state: ProjectRegistryState | null;
  stateSha256: string | null;
  authorization: ProjectHighWater | null;
  calls: ProjectHighWater | null;
  storeRoot: string;
  key: Buffer;
  statesRoot: string;
};

function registrationPath(storeRoot: string, projectId: string): string {
  return join(storeRoot, PROJECT_REGISTRATIONS_DIRECTORY, `${projectId}.json`);
}

function registryRoots(storeRoot: string, projectId: string): { root: string; states: string } {
  const root = join(storeRoot, PROJECT_REGISTRY_DIRECTORY, projectId);
  return { root, states: join(root, REGISTRY_STATES_DIRECTORY) };
}

async function parseRegistrationFile(path: string, key: Buffer, projectId: string): Promise<{
  registration: ProjectRegistration;
  sha256: string;
}> {
  const bytes = await readPrivateRegularFile(path, "trusted project registration", MAX_REGISTRATION_BYTES);
  let registration: ProjectRegistration;
  try {
    registration = ProjectRegistrationSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalRegistration(registration) !== bytes.toString("utf8")) throw new Error("registration is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted project registration is invalid", { cause: error });
  }
  assertRegistrationSignature(key, registration);
  if (registration.projectId !== projectId) throw new Error("trusted project registration belongs to a different project");
  return { registration, sha256: sha256(bytes) };
}

async function parseRegistryStateFile(path: string, key: Buffer, projectId: string): Promise<{
  state: ProjectRegistryState;
  sha256: string;
}> {
  const bytes = await readPrivateRegularFile(path, "trusted project registry state", MAX_REGISTRY_STATE_BYTES);
  let state: ProjectRegistryState;
  try {
    state = ProjectRegistryStateSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalRegistryState(state) !== bytes.toString("utf8")) throw new Error("registry state is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted project registry state is invalid or tampered", { cause: error });
  }
  assertRegistryStateSignature(key, state);
  if (state.projectId !== projectId) throw new Error("trusted project registry state belongs to a different project");
  return { state, sha256: sha256(bytes) };
}

async function hasObservableTrustedState(storeRoot: string, projectId: string): Promise<boolean> {
  const paths = [
    join(storeRoot, AUTHORIZATION_HEADS_DIRECTORY, projectId),
    join(storeRoot, CALL_LEDGERS_DIRECTORY, projectId),
    registryRoots(storeRoot, projectId).root,
  ];
  for (const path of paths) {
    const kind = await pathKind(path);
    if (kind === "unsafe") throw new Error("trusted project registry evidence is unsafe");
    if (kind !== "missing") return true;
  }
  return false;
}

async function readProjectRegistry(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
): Promise<ProjectRegistrySnapshot | null> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  const markerPath = registrationPath(storeRoot, projectId);
  const markerKind = await pathKind(markerPath);
  if (markerKind === "unsafe" || markerKind === "directory") throw new Error("trusted project registration is unsafe");
  if (markerKind === "missing") {
    if (await hasObservableTrustedState(storeRoot, projectId)) {
      throw new Error("registered project registry is missing");
    }
    return null;
  }
  const parsedRegistration = await parseRegistrationFile(markerPath, key, projectId);
  const roots = registryRoots(storeRoot, projectId);
  const rootKind = await pathKind(roots.root);
  if (rootKind === "missing") throw new Error("registered project registry is missing");
  if (rootKind !== "directory") throw new Error("trusted project registry is unsafe");
  const statesKind = await pathKind(roots.states);
  if (statesKind === "unsafe" || statesKind === "file") throw new Error("trusted project registry state directory is unsafe");
  if (statesKind === "missing") {
    return {
      registration: parsedRegistration.registration,
      registrationSha256: parsedRegistration.sha256,
      state: null,
      stateSha256: null,
      authorization: null,
      calls: null,
      storeRoot,
      key,
      statesRoot: roots.states,
    };
  }
  const maximumStates = store.operations?.limits?.registryStates ?? MAX_REGISTRY_STATES;
  const names = await readBoundedPrivateDirectory(
    roots.states,
    "trusted project registry state directory",
    maximumStates,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}\.json$/.test(name) ? "include" : "reject",
  );
  names.sort();
  let previousSha = parsedRegistration.sha256;
  let latest: { state: ProjectRegistryState; sha256: string } | null = null;
  for (const [index, name] of names.entries()) {
    const version = index + 1;
    if (name !== registryStateFilename(version)) throw new Error("trusted project registry state sequence is not contiguous");
    const parsed = await parseRegistryStateFile(join(roots.states, name), key, projectId);
    if (
      parsed.state.version !== version
      || parsed.state.registrationSha256 !== parsedRegistration.sha256
      || parsed.state.predecessorStateSha256 !== previousSha
    ) throw new Error("trusted project registry state chain is invalid or tampered");
    previousSha = parsed.sha256;
    latest = parsed;
  }
  return {
    registration: parsedRegistration.registration,
    registrationSha256: parsedRegistration.sha256,
    state: latest?.state ?? null,
    stateSha256: latest?.sha256 ?? null,
    authorization: latest?.state.authorization ?? null,
    calls: latest?.state.calls ?? null,
    storeRoot,
    key,
    statesRoot: roots.states,
  };
}

async function ensureProjectRegistryForTransition(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
): Promise<ProjectRegistrySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const markerKind = await pathKind(registrationPath(storeRoot, projectId));
  const roots = registryRoots(storeRoot, projectId);
  const registryKind = await pathKind(roots.root);
  if (markerKind === "file" && registryKind === "missing") {
    const initializedSubtrees = [
      join(storeRoot, AUTHORIZATION_HEADS_DIRECTORY, projectId),
      join(storeRoot, CALL_LEDGERS_DIRECTORY, projectId),
    ];
    if ((await Promise.all(initializedSubtrees.map(pathKind))).some((kind) => kind !== "missing")) {
      throw new Error("registered project registry is missing");
    }
    await parseRegistrationFile(registrationPath(storeRoot, projectId), key, projectId);
    await ensurePrivateDirectory(roots.root);
  }
  const existing = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
  if (existing) return existing;
  const store = await trustRoot(projectRoot);
  const registrationsRoot = await ensurePrivateDirectory(join(storeRoot, PROJECT_REGISTRATIONS_DIRECTORY));
  const registration = signedRegistration(key, {
    schemaVersion: 1,
    kind: "generation-project-registration",
    projectId,
    registrationId: randomUUID(),
    registeredAt: new Date().toISOString(),
  });
  const bytes = canonicalRegistration(registration);
  const path = registrationPath(storeRoot, projectId);
  if (!await writePrivateExclusive(path, bytes, "registration-temp-synced", store.operations)) {
    const concurrent = await readWithConcurrentCreateRetry(path, "trusted project registration", MAX_REGISTRATION_BYTES);
    if (!concurrent.equals(Buffer.from(bytes))) throw new Error("trusted project registration conflicts");
  }
  await syncDirectory(registrationsRoot);
  await ensurePrivateDirectory(roots.root);
  const initialized = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
  if (!initialized) throw new Error("trusted project registry initialization did not converge");
  return initialized;
}

async function appendProjectRegistryState(
  projectRoot: string,
  current: ProjectRegistrySnapshot,
  next: { authorization: ProjectHighWater | null; calls: ProjectHighWater | null },
): Promise<ProjectRegistrySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  await ensurePrivateDirectory(current.statesRoot);
  const state = signedRegistryState(current.key, {
    schemaVersion: 1,
    kind: "generation-project-high-water",
    projectId: current.registration.projectId,
    registrationSha256: current.registrationSha256,
    version: (current.state?.version ?? 0) + 1,
    predecessorStateSha256: current.stateSha256 ?? current.registrationSha256,
    authorization: next.authorization,
    calls: next.calls,
  });
  const bytes = canonicalRegistryState(state);
  const path = join(current.statesRoot, registryStateFilename(state.version));
  if (!await writePrivateExclusive(path, bytes, "registry-state-temp-synced", store.operations)) {
    const concurrent = await readWithConcurrentCreateRetry(path, "trusted project registry state", MAX_REGISTRY_STATE_BYTES);
    if (!concurrent.equals(Buffer.from(bytes))) throw new Error("trusted project registry state conflicts");
  }
  const refreshed = await readProjectRegistry(projectRoot, current.registration.projectId, current.storeRoot, current.key);
  if (!refreshed) throw new Error("trusted project registry state publication did not converge");
  return refreshed;
}

async function synchronizeRegistryHighWater(
  projectRoot: string,
  registry: ProjectRegistrySnapshot,
  kind: "authorization" | "calls",
  actual: ProjectHighWater | null,
): Promise<ProjectRegistrySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const expected = registry[kind];
  if (expected && !actual) throw new Error(`trusted ${kind} history is missing below the project registry high-water`);
  if (!actual) return registry;
  if (expected) {
    if (actual.sequence < expected.sequence) throw new Error(`trusted ${kind} history is truncated below the project registry high-water`);
    if (actual.sequence === expected.sequence) {
      if (actual.headSha256 !== expected.headSha256) throw new Error(`trusted ${kind} head does not match the project registry high-water`);
      return registry;
    }
    if (actual.sequence !== expected.sequence + 1) throw new Error(`trusted ${kind} history is ahead of the project registry by more than one transition`);
  } else {
    const initialSequence = kind === "authorization" ? 1 : 0;
    if (actual.sequence !== initialSequence) throw new Error(`trusted ${kind} history cannot initialize the project registry high-water`);
  }
  const store = await trustRoot(projectRoot);
  await store.operations?.checkpoint?.(kind === "authorization"
    ? "registry-before-authorization-advance"
    : "registry-before-call-advance");
  return appendProjectRegistryState(projectRoot, registry, {
    authorization: kind === "authorization" ? actual : registry.authorization,
    calls: kind === "calls" ? actual : registry.calls,
  });
}

function expectedRecord(
  manifest: ProjectManifest,
  gate: ProjectManifest["gates"][number],
  planBytes: Buffer,
  descriptor: GateSnapshotDescriptor,
  sequence: number,
  predecessor: SignedRecordBase["predecessor"],
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
    schemaVersion: 2,
    kind: "generation-authorization-approval",
    recordId: gate.approvalId,
    projectId: manifest.projectId,
    approvalId: gate.approvalId,
    sequence,
    predecessor,
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

function parseSignedRecordBytes(bytes: Buffer, key: Buffer): SignedRecord {
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

type AuthorizationHeadChainEntry = {
  head: AuthorizationHead;
  headSha256: string;
  record: SignedRecord;
};

async function readAuthorizationHeadChain(
  projectRoot: string,
  projectId: string,
): Promise<AuthorizationHeadChainEntry[]> {
  assertGenerationLeaseHeld(projectRoot);
  const { storeRoot, key } = await readKey(projectRoot);
  const store = await trustRoot(projectRoot);
  const headsRoot = join(storeRoot, AUTHORIZATION_HEADS_DIRECTORY, projectId, HEADS_DIRECTORY);
  try {
    await lstat(headsRoot);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = await readBoundedPrivateDirectory(
    headsRoot,
    "trusted authorization head directory",
    store.operations?.limits?.authorizationHeads ?? MAX_AUTHORIZATION_HEADS,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}\.json$/.test(name) ? "include" : "reject",
    store.operations,
    "authorization-head-directory-opened",
  );
  names.sort();
  const chain: AuthorizationHeadChainEntry[] = [];
  for (const [index, name] of names.entries()) {
    const sequence = index + 1;
    if (name !== authorizationHeadFilename(sequence)) {
      throw new Error("trusted authorization head sequence is not contiguous");
    }
    const bytes = await readPrivateRegularFile(join(headsRoot, name), "trusted authorization head", MAX_HEAD_BYTES);
    let head: AuthorizationHead;
    try {
      head = AuthorizationHeadSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (canonicalAuthorizationHead(head) !== bytes.toString("utf8")) throw new Error("head is not canonical");
    } catch (error: unknown) {
      throw new Error("trusted authorization head is invalid", { cause: error });
    }
    assertAuthorizationHeadSignature(key, head);
    const previous = chain.at(-1);
    if (
      head.projectId !== projectId
      || head.sequence !== sequence
      || head.predecessorHeadSha256 !== (previous?.headSha256 ?? null)
    ) throw new Error("trusted authorization head chain is invalid");
    const recordBytes = await readPrivateRegularFile(
      join(storeRoot, RECORDS_DIRECTORY, `${head.recordId}.json`),
      "trusted authorization record",
      MAX_RECORD_BYTES,
    );
    if (sha256(recordBytes) !== head.recordSha256) throw new Error("trusted authorization head record digest is invalid");
    const record = parseSignedRecordBytes(recordBytes, key);
    if (
      record.projectId !== projectId
      || record.sequence !== sequence
      || record.recordId !== head.recordId
      || record.approvalId !== head.approvalId
      || record.authorizationPlanSha256 !== head.authorizationPlanSha256
      || JSON.stringify(record.predecessor) !== JSON.stringify(previous
        ? { recordId: previous.record.recordId, recordSha256: previous.head.recordSha256 }
        : null)
    ) throw new Error("trusted authorization record chain is invalid");
    chain.push({ head, headSha256: sha256(bytes), record });
  }
  return chain;
}

async function readSynchronizedAuthorizationHeadChain(
  projectRoot: string,
  projectId: string,
): Promise<AuthorizationHeadChainEntry[]> {
  assertGenerationLeaseHeld(projectRoot);
  const { storeRoot, key } = await readKey(projectRoot);
  const chain = await readAuthorizationHeadChain(projectRoot, projectId);
  const registry = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
  if (!registry) {
    if (chain.length > 0) throw new Error("registered project registry is missing");
    return chain;
  }
  const current = chain.at(-1);
  await synchronizeRegistryHighWater(projectRoot, registry, "authorization", current
    ? { sequence: current.head.sequence, headSha256: current.headSha256 }
    : null);
  return chain;
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
  return withGenerationLease(projectRoot, (canonicalRoot) =>
    appendTrustedGenerationAuthorizationRecordUnderLease(canonicalRoot, input));
}

async function appendTrustedGenerationAuthorizationRecordUnderLease(
  projectRoot: string,
  input: {
    manifest: ProjectManifest;
    gate: ProjectManifest["gates"][number];
    planBytes: Buffer;
    descriptor: GateSnapshotDescriptor;
  },
): Promise<GenerationAuthorizationTrustBinding> {
  assertGenerationLeaseHeld(projectRoot);
  const project = await readProject(projectRoot);
  if (project.projectId !== input.manifest.projectId) {
    throw new Error("trusted authorization project identity changed during approval");
  }
  const store = await trustRoot(projectRoot);
  const { storeRoot, key } = await createOrReadKey(projectRoot);
  await ensureProjectRegistryForTransition(projectRoot, project.projectId, storeRoot, key);
  const projectHeadsRoot = await ensurePrivateDirectory(join(
    storeRoot,
    AUTHORIZATION_HEADS_DIRECTORY,
    project.projectId,
    HEADS_DIRECTORY,
  ));
  const chain = await readSynchronizedAuthorizationHeadChain(projectRoot, project.projectId);
  const current = chain.at(-1);
  if (current && current.record.recordId === input.gate.approvalId) {
    const exact = expectedRecord(
      input.manifest,
      input.gate,
      input.planBytes,
      input.descriptor,
      current.record.sequence,
      current.record.predecessor,
    );
    const { signature: _signature, ...base } = current.record;
    if (JSON.stringify(SignedRecordBaseSchema.parse(base)) !== JSON.stringify(exact)) {
      throw new Error("trusted authorization record conflicts with immutable approval evidence");
    }
    return AuthorizationTrustBindingSchema.parse({
      recordId: current.record.recordId,
      recordSha256: current.head.recordSha256,
    });
  }
  const sequence = (current?.head.sequence ?? 0) + 1;
  const predecessor = current
    ? { recordId: current.record.recordId, recordSha256: current.head.recordSha256 }
    : null;
  const record = signedRecord(key, expectedRecord(
    input.manifest,
    input.gate,
    input.planBytes,
    input.descriptor,
    sequence,
    predecessor,
  ));
  const bytes = canonicalRecord(record);
  const path = join(storeRoot, RECORDS_DIRECTORY, `${record.recordId}.json`);
  if (!await writePrivateExclusive(path, bytes, "record-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(path, "trusted authorization record", MAX_RECORD_BYTES);
    if (!existing.equals(Buffer.from(bytes))) throw new Error("trusted authorization record conflicts with immutable approval evidence");
    parseSignedRecordBytes(existing, key);
  }
  const recordSha256 = sha256(bytes);
  const head = signedAuthorizationHead(key, {
    schemaVersion: 1,
    kind: "generation-authorization-head",
    projectId: project.projectId,
    sequence,
    recordId: record.recordId,
    recordSha256,
    approvalId: record.approvalId,
    authorizationPlanSha256: record.authorizationPlanSha256,
    predecessorHeadSha256: current?.headSha256 ?? null,
  });
  const headBytes = canonicalAuthorizationHead(head);
  const headPath = join(projectHeadsRoot, authorizationHeadFilename(sequence));
  if (!await writePrivateExclusive(headPath, headBytes, "authorization-head-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(headPath, "trusted authorization head", MAX_HEAD_BYTES);
    if (!existing.equals(Buffer.from(headBytes))) {
      throw new Error("trusted authorization head conflicts with immutable approval sequence");
    }
  }
  const registry = await readProjectRegistry(projectRoot, project.projectId, storeRoot, key);
  if (!registry) throw new Error("trusted project registry is missing after authorization publication");
  await synchronizeRegistryHighWater(projectRoot, registry, "authorization", {
    sequence,
    headSha256: sha256(headBytes),
  });
  return AuthorizationTrustBindingSchema.parse({ recordId: record.recordId, recordSha256 });
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
): Promise<number> {
  return withGenerationLease(projectRoot, (canonicalRoot) =>
    assertTrustedGenerationAuthorizationRecordUnderLease(canonicalRoot, rawBinding, rawPlan, gate, descriptor));
}

async function assertTrustedGenerationAuthorizationRecordUnderLease(
  projectRoot: string,
  rawBinding: GenerationAuthorizationTrustBinding,
  rawPlan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
  descriptor?: GateSnapshotDescriptor,
): Promise<number> {
  assertGenerationLeaseHeld(projectRoot);
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
  const binding = AuthorizationTrustBindingSchema.parse(rawBinding);
  const chain = await readSynchronizedAuthorizationHeadChain(projectRoot, project.projectId);
  const trusted = chain.find(({ head }) =>
    head.recordId === binding.recordId && head.recordSha256 === binding.recordSha256
  );
  if (!trusted) throw new Error("trusted authorization record is not in the external approval history");
  exactRecordForPlan(plan, gate, trusted.record, descriptor);
  return trusted.record.sequence;
}

export async function trustedGenerationAuthorizationForGate(
  projectRoot: string,
  plan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
  descriptor: GateSnapshotDescriptor,
): Promise<GenerationAuthorizationTrustBinding> {
  return withGenerationLease(projectRoot, (canonicalRoot) =>
    trustedGenerationAuthorizationForGateUnderLease(canonicalRoot, plan, gate, descriptor));
}

async function trustedGenerationAuthorizationForGateUnderLease(
  projectRoot: string,
  plan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
  descriptor: GateSnapshotDescriptor,
): Promise<GenerationAuthorizationTrustBinding> {
  assertGenerationLeaseHeld(projectRoot);
  const binding = AuthorizationTrustBindingSchema.parse({
    recordId: gate.approvalId,
    recordSha256: sha256(await readPrivateRegularFile(
      join((await trustRoot(projectRoot)).root, RECORDS_DIRECTORY, `${gate.approvalId}.json`),
      "trusted authorization record",
      MAX_RECORD_BYTES,
    )),
  });
  await assertTrustedGenerationAuthorizationRecordUnderLease(projectRoot, binding, plan, gate, descriptor);
  await assertTrustedGenerationAuthorizationCurrentUnderLease(projectRoot, binding, plan, gate);
  return binding;
}

export async function assertTrustedGenerationAuthorizationCurrent(
  projectRoot: string,
  rawBinding: GenerationAuthorizationTrustBinding,
  rawPlan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
): Promise<void> {
  return withGenerationLease(projectRoot, (canonicalRoot) =>
    assertTrustedGenerationAuthorizationCurrentUnderLease(canonicalRoot, rawBinding, rawPlan, gate));
}

async function assertTrustedGenerationAuthorizationCurrentUnderLease(
  projectRoot: string,
  rawBinding: GenerationAuthorizationTrustBinding,
  rawPlan: GenerationAuthorizationPlan,
  gate: AuthorizationGateBinding,
): Promise<void> {
  assertGenerationLeaseHeld(projectRoot);
  const binding = AuthorizationTrustBindingSchema.parse(rawBinding);
  const plan = GenerationAuthorizationPlanSchema.parse(rawPlan);
  const chain = await readSynchronizedAuthorizationHeadChain(projectRoot, plan.projectId);
  const current = chain.at(-1);
  if (
    !current
    || current.head.recordId !== binding.recordId
    || current.head.recordSha256 !== binding.recordSha256
    || current.head.approvalId !== gate.approvalId
    || current.head.authorizationPlanSha256 !== gate.authorizationPlanSha256
    || current.head.authorizationPlanSha256 !== sha256(canonicalContractFile(plan))
  ) throw new Error("trusted authorization is not the external current approval");
}

export type TrustedGenerationCallEvent = TrustedCallEvent;

type TrustedCallHeadChainEntry = {
  head: TrustedCallHead;
  headSha256: string;
  event: TrustedCallEvent | null;
};

async function readProjectCallLedger(projectRoot: string): Promise<{
  exists: boolean;
  entries: CallLedgerEntry[];
}> {
  assertGenerationLeaseHeld(projectRoot);
  const path = join(projectRoot, CALL_LEDGER_PROJECT_PATH);
  const kind = await pathKind(path);
  if (kind === "missing") return { exists: false, entries: [] };
  if (kind !== "file") throw new Error("project call ledger is unsafe or unreadable");
  const configuration = await trustConfiguration(projectRoot);
  const maximumBytes = configuration.operations?.limits?.projectLedgerBytes ?? MAX_PROJECT_CALL_LEDGER_BYTES;
  const maximumEntries = configuration.operations?.limits?.projectLedgerEntries ?? MAX_PROJECT_CALL_LEDGER_ENTRIES;
  const bytes = await readPrivateRegularFile(path, "project call ledger", maximumBytes);
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text === "") throw new Error("project call ledger is not complete JSONL");
  const lines: string[] = [];
  let start = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text.charCodeAt(offset) !== 10) continue;
    if (lines.length >= maximumEntries) throw new Error("project call ledger has too many entries");
    lines.push(text.slice(start, offset));
    start = offset + 1;
  }
  const entries = lines.map((line, index) => {
    try {
      const entry = CallLedgerEntrySchema.parse(JSON.parse(line));
      if (line !== JSON.stringify(entry)) throw new Error("non-canonical ledger line");
      return entry;
    } catch (error: unknown) {
      throw new Error(`project call ledger entry ${index + 1} is invalid`, { cause: error });
    }
  });
  const states = new Map<string, CallLedgerEntry>();
  for (const entry of entries) {
    const tuple = `${entry.jobId}\u0000${entry.slideId}\u0000${entry.attempt}\u0000${entry.requestOrdinal}`;
    const prior = states.get(tuple);
    if (entry.entryKind === "admission") {
      if (prior) throw new Error("project call ledger has a conflicting duplicate admission");
      states.set(tuple, entry);
    } else {
      if (!prior || prior.entryKind !== "admission") {
        throw new Error("project call ledger has a terminal entry without an admission");
      }
      if (states.has(`${tuple}\u0000terminal`)) {
        throw new Error("project call ledger has a conflicting duplicate terminal entry");
      }
      if (prior.admissionTokenSha256 !== entry.admissionTokenSha256) {
        throw new Error("project call ledger terminal token does not match its admission");
      }
      states.set(`${tuple}\u0000terminal`, entry);
    }
  }
  return { exists: true, entries };
}

function sameLedger(left: CallLedgerEntry[], right: CallLedgerEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function callLedgerRoots(storeRoot: string, projectId: string): {
  root: string;
  events: string;
  heads: string;
} {
  const root = join(storeRoot, CALL_LEDGERS_DIRECTORY, projectId);
  return { root, events: join(root, EVENTS_DIRECTORY), heads: join(root, HEADS_DIRECTORY) };
}

async function parseCallEventFile(
  path: string,
  key: Buffer,
  expectedProjectId: string,
): Promise<{ event: TrustedCallEvent; bytes: Buffer; sha256: string }> {
  const bytes = await readPrivateRegularFile(path, "trusted call ledger event", MAX_CALL_EVENT_BYTES);
  let event: TrustedCallEvent;
  try {
    event = TrustedCallEventSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalCallEvent(event) !== bytes.toString("utf8")) throw new Error("event is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted call ledger event is invalid", { cause: error });
  }
  assertCallEventSignature(key, event);
  if (event.projectId !== expectedProjectId) throw new Error("trusted call ledger event belongs to a different project");
  return { event, bytes, sha256: sha256(bytes) };
}

async function parseCallHeadFile(
  path: string,
  key: Buffer,
  expectedProjectId: string,
): Promise<{ head: TrustedCallHead; bytes: Buffer; sha256: string }> {
  const bytes = await readPrivateRegularFile(path, "trusted call ledger head", MAX_CALL_HEAD_BYTES);
  let head: TrustedCallHead;
  try {
    head = TrustedCallHeadSchema.parse(JSON.parse(bytes.toString("utf8")));
    const { signature: _signature, ...base } = head;
    TrustedCallHeadBaseSchema.parse(base);
    if (canonicalCallHead(head) !== bytes.toString("utf8")) throw new Error("head is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted call ledger head is invalid", { cause: error });
  }
  assertCallHeadSignature(key, head);
  if (head.projectId !== expectedProjectId) throw new Error("trusted call ledger head belongs to a different project");
  return { head, bytes, sha256: sha256(bytes) };
}

async function initializeEmptyCallLedger(
  projectRoot: string,
  projectId: string,
): Promise<void> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  const { storeRoot, key } = await createOrReadKey(projectRoot);
  const roots = callLedgerRoots(storeRoot, projectId);
  await ensurePrivateDirectory(roots.events);
  await ensurePrivateDirectory(roots.heads);
  const empty = signedCallHead(key, {
    schemaVersion: 1,
    kind: "generation-call-ledger-head",
    projectId,
    sequence: 0,
    event: null,
    predecessorHeadSha256: null,
  });
  const bytes = canonicalCallHead(empty);
  const path = join(roots.heads, callHeadFilename(0));
  if (!await writePrivateExclusive(path, bytes, "call-head-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(path, "trusted call ledger head", MAX_CALL_HEAD_BYTES);
    if (!existing.equals(Buffer.from(bytes))) throw new Error("trusted call ledger empty head conflicts");
  }
}

async function readCallHeadChain(
  projectRoot: string,
  projectId: string,
): Promise<{
  storeRoot: string;
  key: Buffer;
  roots: ReturnType<typeof callLedgerRoots>;
  chain: TrustedCallHeadChainEntry[];
}> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  const { storeRoot, key } = await readKey(projectRoot);
  const roots = callLedgerRoots(storeRoot, projectId);
  const names = await readBoundedPrivateDirectory(
    roots.heads,
    "trusted call ledger head directory",
    store.operations?.limits?.callHeads ?? MAX_CALL_EVENTS + 1,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}\.json$/.test(name) ? "include" : "reject",
    store.operations,
    "call-head-directory-opened",
  );
  names.sort();
  if (names.length === 0) throw new Error("trusted call ledger empty head is missing");
  if (names[0] !== callHeadFilename(0)) throw new Error("trusted call ledger empty head is missing");
  const chain: TrustedCallHeadChainEntry[] = [];
  for (const [index, name] of names.entries()) {
    if (name !== callHeadFilename(index)) throw new Error("trusted call ledger head sequence is not contiguous");
    const parsed = await parseCallHeadFile(join(roots.heads, name), key, projectId);
    const previous = chain.at(-1);
    if (
      parsed.head.sequence !== index
      || parsed.head.predecessorHeadSha256 !== (previous?.headSha256 ?? null)
    ) throw new Error("trusted call ledger head chain is invalid");
    let event: TrustedCallEvent | null = null;
    if (index > 0) {
      if (!parsed.head.event) throw new Error("trusted call ledger head has no event");
      const eventFile = await parseCallEventFile(
        join(roots.events, callEventFilename(index, parsed.head.event.eventId)),
        key,
        projectId,
      );
      if (eventFile.sha256 !== parsed.head.event.eventSha256) throw new Error("trusted call ledger head event digest is invalid");
      const priorEvent = previous?.event;
      if (
        eventFile.event.sequence !== index
        || JSON.stringify(eventFile.event.predecessor) !== JSON.stringify(priorEvent
          ? { eventId: priorEvent.eventId, eventSha256: previous!.head.event!.eventSha256 }
          : null)
      ) throw new Error("trusted call ledger event chain is invalid");
      event = eventFile.event;
    }
    chain.push({ head: parsed.head, headSha256: parsed.sha256, event });
  }
  return { storeRoot, key, roots, chain };
}

async function successorCallEvents(
  projectRoot: string,
  roots: ReturnType<typeof callLedgerRoots>,
  key: Buffer,
  projectId: string,
  current: TrustedCallHeadChainEntry,
): Promise<Array<{ event: TrustedCallEvent; sha256: string }>> {
  assertGenerationLeaseHeld(projectRoot);
  const nextSequence = current.head.sequence + 1;
  const prefix = `${String(nextSequence).padStart(16, "0")}-`;
  const store = await trustRoot(projectRoot);
  const names = await readBoundedPrivateDirectory(
    roots.events,
    "trusted call ledger event directory",
    store.operations?.limits?.callEvents ?? MAX_CALL_EVENTS,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}-[0-9a-f-]{36}\.json$/.test(name) ? "include" : "reject",
    store.operations,
    "call-event-directory-opened",
  );
  const candidates: Array<{ event: TrustedCallEvent; sha256: string }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const parsed = await parseCallEventFile(join(roots.events, name), key, projectId);
    if (
      parsed.event.sequence === nextSequence
      && JSON.stringify(parsed.event.predecessor) === JSON.stringify(current.event
        ? { eventId: current.event.eventId, eventSha256: current.head.event!.eventSha256 }
        : null)
    ) candidates.push({ event: parsed.event, sha256: parsed.sha256 });
  }
  return candidates;
}

async function publishCallHead(
  projectRoot: string,
  key: Buffer,
  roots: ReturnType<typeof callLedgerRoots>,
  current: TrustedCallHeadChainEntry,
  event: TrustedCallEvent,
  eventSha256: string,
): Promise<void> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  const head = signedCallHead(key, {
    schemaVersion: 1,
    kind: "generation-call-ledger-head",
    projectId: event.projectId,
    sequence: event.sequence,
    event: { eventId: event.eventId, eventSha256 },
    predecessorHeadSha256: current.headSha256,
  });
  const bytes = canonicalCallHead(head);
  const path = join(roots.heads, callHeadFilename(event.sequence));
  if (!await writePrivateExclusive(path, bytes, "call-head-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(path, "trusted call ledger head", MAX_CALL_HEAD_BYTES);
    if (!existing.equals(Buffer.from(bytes))) throw new Error("trusted call ledger head conflicts with event history");
  }
  await store.operations?.checkpoint?.("call-head-published");
}

async function synchronizeTrustedCallLedger(projectRoot: string, forTransition = false): Promise<{
  entries: CallLedgerEntry[];
  events: TrustedCallEvent[];
  current: TrustedCallHeadChainEntry | null;
  storeRoot: string | null;
  key: Buffer | null;
  roots: ReturnType<typeof callLedgerRoots> | null;
}> {
  assertGenerationLeaseHeld(projectRoot);
  const project = await readProject(projectRoot);
  let local = await readProjectCallLedger(projectRoot);
  const store = await trustRoot(projectRoot);
  const roots = callLedgerRoots(store.root, project.projectId);
  const keyPath = join(store.root, KEY_FILE);
  const keyKind = await pathKind(keyPath);
  if (keyKind === "unsafe" || keyKind === "directory") throw new Error("trusted authorization HMAC key is unsafe");
  if (keyKind === "missing" && !forTransition) {
    if (local.entries.length > 0 || await pathKind(roots.root) !== "missing") {
      throw new Error("trusted call ledger HMAC key is missing for observable state");
    }
    return { entries: [], events: [], current: null, storeRoot: null, key: null, roots: null };
  }
  const keyInfo = forTransition ? await createOrReadKey(projectRoot) : await readKey(projectRoot);
  let registry = forTransition
    ? await ensureProjectRegistryForTransition(projectRoot, project.projectId, keyInfo.storeRoot, keyInfo.key)
    : await readProjectRegistry(projectRoot, project.projectId, keyInfo.storeRoot, keyInfo.key);
  const rootKind = await pathKind(roots.root);
  if (rootKind === "unsafe" || rootKind === "file") throw new Error("trusted call ledger directory is unsafe");
  if (rootKind === "missing") {
    if (registry?.calls) throw new Error("trusted call ledger is missing below the project registry high-water");
    if (local.entries.length > 0) throw new Error("trusted call ledger head is missing for a non-empty project ledger");
    if (!forTransition) return {
      entries: [], events: [], current: null,
      storeRoot: keyInfo.storeRoot, key: keyInfo.key, roots,
    };
    if (!registry) throw new Error("trusted project registry is missing during call-ledger initialization");
    await initializeEmptyCallLedger(projectRoot, project.projectId);
    const emptyTrusted = await readCallHeadChain(projectRoot, project.projectId);
    const emptyCurrent = emptyTrusted.chain.at(-1)!;
    registry = await synchronizeRegistryHighWater(projectRoot, registry, "calls", {
      sequence: emptyCurrent.head.sequence,
      headSha256: emptyCurrent.headSha256,
    });
  }
  if (!registry) throw new Error("registered project registry is missing for the trusted call ledger");
  let trusted = await readCallHeadChain(projectRoot, project.projectId);
  let currentHead = trusted.chain.at(-1)!;
  registry = await synchronizeRegistryHighWater(projectRoot, registry, "calls", {
    sequence: currentHead.head.sequence,
    headSha256: currentHead.headSha256,
  });
  for (let recovery = 0; recovery < 2; recovery += 1) {
    const externalEntries = trusted.chain.slice(1).map(({ event }) => event!.entry);
    const current = trusted.chain.at(-1)!;
    const localIsExact = sameLedger(local.entries, externalEntries);
    const localHasOneExtra = local.entries.length === externalEntries.length + 1
      && sameLedger(local.entries.slice(0, -1), externalEntries);
    if (!localIsExact && !localHasOneExtra) {
      throw new Error("project call ledger does not match the trusted call ledger");
    }
    const successors = await successorCallEvents(projectRoot, trusted.roots, trusted.key, project.projectId, current);
    const candidates = localHasOneExtra
      ? successors.filter(({ event }) => JSON.stringify(event.entry) === JSON.stringify(local.entries.at(-1)))
      : successors;
    if (candidates.length > 1 || (localHasOneExtra && candidates.length !== 1)) {
      throw new Error("trusted call ledger recovery is ambiguous");
    }
    if (candidates.length === 0) {
      if (localHasOneExtra) throw new Error("project call ledger has no trusted external event");
      return {
        entries: externalEntries,
        events: trusted.chain.slice(1).map(({ event }) => event!),
        current,
        storeRoot: trusted.storeRoot,
        key: trusted.key,
        roots: trusted.roots,
      };
    }
    const candidate = candidates[0]!;
    if (localIsExact) {
      await store.operations?.checkpoint?.("call-recovery-before-project-append");
      appendPrivateInputLine(join(projectRoot, CALL_LEDGER_PROJECT_PATH), JSON.stringify(candidate.event.entry));
      local = { exists: true, entries: [...local.entries, candidate.event.entry] };
    }
    await publishCallHead(projectRoot, trusted.key, trusted.roots, current, candidate.event, candidate.sha256);
    trusted = await readCallHeadChain(projectRoot, project.projectId);
    currentHead = trusted.chain.at(-1)!;
    registry = await synchronizeRegistryHighWater(projectRoot, registry, "calls", {
      sequence: currentHead.head.sequence,
      headSha256: currentHead.headSha256,
    });
  }
  throw new Error("trusted call ledger recovery did not converge");
}

export async function readTrustedGenerationCallLedger(projectRoot: string): Promise<{
  entries: CallLedgerEntry[];
  events: TrustedCallEvent[];
}> {
  return withGenerationLease(projectRoot, async (canonicalRoot) => {
    const trusted = await synchronizeTrustedCallLedger(canonicalRoot);
    return { entries: trusted.entries, events: trusted.events };
  });
}

export async function readTrustedGenerationCallLedgerUnderLease(projectRoot: string): Promise<{
  entries: CallLedgerEntry[];
  events: TrustedCallEvent[];
}> {
  assertGenerationLeaseHeld(projectRoot);
  const trusted = await synchronizeTrustedCallLedger(projectRoot);
  return { entries: trusted.entries, events: trusted.events };
}

export async function appendTrustedGenerationCallLedgerEntry(
  projectRoot: string,
  rawJob: ImageGenerationJob,
  rawEntry: CallLedgerEntry,
): Promise<void> {
  return withGenerationLease(projectRoot, (canonicalRoot) =>
    appendTrustedGenerationCallLedgerEntryUnderLease(canonicalRoot, rawJob, rawEntry));
}

async function appendTrustedGenerationCallLedgerEntryUnderLease(
  projectRoot: string,
  rawJob: ImageGenerationJob,
  rawEntry: CallLedgerEntry,
): Promise<void> {
  assertGenerationLeaseHeld(projectRoot);
  const entry = CallLedgerEntrySchema.parse(rawEntry);
  const project = await readProject(projectRoot);
  if (rawJob.projectId !== project.projectId || entry.jobId !== rawJob.jobId) {
    throw new Error("trusted call ledger event does not bind the project job");
  }
  const trusted = await synchronizeTrustedCallLedger(projectRoot, true);
  if (!trusted.current || !trusted.roots || !trusted.key || !trusted.storeRoot) {
    throw new Error("trusted call ledger transition is not initialized");
  }
  const sequence = trusted.current.head.sequence + 1;
  const predecessor = trusted.current.event
    ? { eventId: trusted.current.event.eventId, eventSha256: trusted.current.head.event!.eventSha256 }
    : null;
  const event = signedCallEvent(trusted.key, {
    schemaVersion: 1,
    kind: "generation-call-ledger-event",
    eventId: randomUUID(),
    projectId: project.projectId,
    sequence,
    predecessor,
    authorizationApprovalId: rawJob.authorizationGate.approvalId,
    authorizationDigest: rawJob.authorizationDigest,
    authorizationTrust: rawJob.authorizationTrust,
    entry,
  });
  const bytes = canonicalCallEvent(event);
  const eventPath = join(trusted.roots.events, callEventFilename(sequence, event.eventId));
  const store = await trustRoot(projectRoot);
  if (!await writePrivateExclusive(eventPath, bytes, "call-event-temp-synced", store.operations)) {
    throw new Error("trusted call ledger event identity already exists");
  }
  await store.operations?.checkpoint?.("call-event-published");
  appendPrivateInputLine(join(projectRoot, CALL_LEDGER_PROJECT_PATH), JSON.stringify(entry));
  await store.operations?.checkpoint?.("call-project-ledger-appended");
  await publishCallHead(projectRoot, trusted.key, trusted.roots, trusted.current, event, sha256(bytes));
  const registry = await readProjectRegistry(projectRoot, project.projectId, trusted.storeRoot, trusted.key);
  if (!registry) throw new Error("trusted project registry is missing after call publication");
  const refreshed = await readCallHeadChain(projectRoot, project.projectId);
  const current = refreshed.chain.at(-1)!;
  await synchronizeRegistryHighWater(projectRoot, registry, "calls", {
    sequence: current.head.sequence,
    headSha256: current.headSha256,
  });
}

export function assertTrustedCallEventJobBinding(
  rawEvent: TrustedGenerationCallEvent,
  job: ImageGenerationJob,
): void {
  const event = TrustedCallEventSchema.parse(rawEvent);
  const page = job.pages.find(({ slideId }) => slideId === event.entry.slideId);
  if (
    event.projectId !== job.projectId
    || event.entry.jobId !== job.jobId
    || event.authorizationApprovalId !== job.authorizationGate.approvalId
    || event.authorizationDigest !== job.authorizationDigest
    || JSON.stringify(event.authorizationTrust) !== JSON.stringify(job.authorizationTrust)
    || !page
    || page.attempt !== event.entry.attempt
  ) throw new Error("trusted call ledger event does not bind its immutable authorized job tuple");
}
