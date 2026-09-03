import { constants } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { GateSnapshotDescriptor } from "../project/evidence.js";
import { syncDirectory } from "../project/durable.js";
import { promoteExclusive } from "../project/exclusive.js";
import { canonicalPotential } from "../project/paths.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject, readProjectForTrustedAuthorization } from "../project/store.js";
import {
  ClientAcceptanceTransactionSchema,
  type ClientAcceptanceTransaction,
  type ClientSmokeCopyAnchor,
  type ProjectManifest,
} from "../project/schemas.js";
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
import { readRevisionSnapshot } from "../revisions/snapshot.js";

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
const CLIENT_ACCEPTANCE_DIRECTORY = "client-acceptance";
const ACCEPTANCE_EVENTS_DIRECTORY = "events";
const ACCEPTANCE_HEADS_DIRECTORY = "heads";
const MAX_ACCEPTANCE_EVENT_BYTES = 32 * 1024;
const MAX_ACCEPTANCE_HEAD_BYTES = 16 * 1024;
const MAX_ACCEPTANCE_EVENTS = 10_000;
const MAX_ACCEPTANCE_REGISTRATION_BYTES = 64 * 1024;
const MAX_ACCEPTANCE_REGISTRATIONS = 10_000;
const MAX_REGISTRATION_BYTES = 16 * 1024;
const ROOT_AUTHORITY_DIRECTORY = "authority";
const ROOT_AUTHORITY_STATES_DIRECTORY = "states";
const ROOT_AUTHORITY_HEADS_DIRECTORY = "heads";
const ROOT_AUTHORITY_CURRENT_FILE = "current.json";
const MAX_ROOT_AUTHORITY_BYTES = 32 * 1024;
const MAX_ROOT_AUTHORITY_STATES = MAX_ACCEPTANCE_REGISTRATIONS * 3 + 1;
const MAX_REGISTRY_STATE_BYTES = 16 * 1024;
const MAX_REGISTRY_STATES = MAX_AUTHORIZATION_HEADS + MAX_CALL_EVENTS + MAX_ACCEPTANCE_EVENTS;
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
  | "acceptance-registration-temp-synced"
  | "acceptance-registration-published"
  | "acceptance-authority-registration-state-temp-synced"
  | "acceptance-authority-registration-state-published"
  | "acceptance-authority-registration-head-temp-synced"
  | "acceptance-authority-registration-head-published"
  | "acceptance-authority-registration-current-temp-synced"
  | "acceptance-authority-registration-current-published"
  | "acceptance-authority-pending-state-temp-synced"
  | "acceptance-authority-pending-state-published"
  | "acceptance-authority-pending-head-temp-synced"
  | "acceptance-authority-pending-head-published"
  | "acceptance-authority-pending-current-temp-synced"
  | "acceptance-authority-pending-current-published"
  | "acceptance-authority-completed-state-temp-synced"
  | "acceptance-authority-completed-state-published"
  | "acceptance-authority-completed-head-temp-synced"
  | "acceptance-authority-completed-head-published"
  | "acceptance-authority-completed-current-temp-synced"
  | "acceptance-authority-completed-current-published"
  | "registry-state-temp-synced"
  | "registry-before-authorization-advance"
  | "registry-before-call-advance"
  | "acceptance-event-temp-synced"
  | "acceptance-event-published"
  | "acceptance-head-temp-synced"
  | "acceptance-head-published"
  | "registry-before-acceptance-advance"
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

const RootAcceptanceAuthoritySchema = z.object({
  initialized: z.boolean(),
  registrationSequence: z.number().int().nonnegative(),
  registrationSha256: z.string().regex(SHA256).nullable(),
  registrationSetSha256: z.string().regex(SHA256).nullable(),
  chain: z.object({
    sequence: z.number().int().positive(),
    headSha256: z.string().regex(SHA256),
    state: z.enum(["pending", "completed"]),
  }).strict().nullable(),
}).strict().superRefine((authority, context) => {
  const empty = authority.registrationSequence === 0;
  if (
    authority.initialized === empty
    || (authority.registrationSha256 === null) !== empty
    || (authority.registrationSetSha256 === null) !== empty
    || (!authority.initialized && authority.chain !== null)
  ) {
    context.addIssue({ code: "custom", message: "root acceptance authority initialization is inconsistent" });
  }
});

const ProjectRootAuthorityBaseSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("generation-project-registration-authority"),
  projectId: z.string().uuid(),
  baseRegistrationSha256: z.string().regex(SHA256),
  version: z.number().int().positive(),
  predecessorAuthoritySha256: z.string().regex(SHA256),
  clientAcceptance: RootAcceptanceAuthoritySchema,
}).strict();

const ProjectRootAuthoritySchema = ProjectRootAuthorityBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const ProjectRootAuthorityHeadBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-project-registration-authority-head"),
  projectId: z.string().uuid(),
  version: z.number().int().positive(),
  authoritySha256: z.string().regex(SHA256),
  predecessorHeadSha256: z.string().regex(SHA256).nullable(),
}).strict();

const ProjectRootAuthorityHeadSchema = ProjectRootAuthorityHeadBaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const HighWaterSchema = z.object({
  sequence: z.number().int().nonnegative(),
  headSha256: z.string().regex(SHA256),
}).strict();

const ProjectRegistryStateV1BaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("generation-project-high-water"),
  projectId: z.string().uuid(),
  registrationSha256: z.string().regex(SHA256),
  version: z.number().int().positive(),
  predecessorStateSha256: z.string().regex(SHA256).nullable(),
  authorization: HighWaterSchema.nullable(),
  calls: HighWaterSchema.nullable(),
}).strict();

const ProjectRegistryStateV1Schema = ProjectRegistryStateV1BaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const ProjectRegistryStateV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("generation-project-high-water"),
  projectId: z.string().uuid(),
  registrationSha256: z.string().regex(SHA256),
  version: z.number().int().positive(),
  predecessorStateSha256: z.string().regex(SHA256).nullable(),
  authorization: HighWaterSchema.nullable(),
  calls: HighWaterSchema.nullable(),
  clientAcceptance: HighWaterSchema.nullable(),
}).strict();

const ProjectRegistryStateV2Schema = ProjectRegistryStateV2BaseSchema.extend({
  signature: z.string().regex(SHA256),
}).strict();

const ProjectRegistryStateSchema = z.union([
  ProjectRegistryStateV1Schema,
  ProjectRegistryStateV2Schema,
]);

const ClientAcceptanceCommitmentSchema = ClientAcceptanceTransactionSchema;

const ClientAcceptanceEventCommonShape = {
  kind: z.literal("client-acceptance-event"),
  eventId: z.string().uuid(),
  projectId: z.string().uuid(),
  sequence: z.number().int().positive(),
  predecessor: z.object({ eventId: z.string().uuid(), eventSha256: z.string().regex(SHA256) }).strict().nullable(),
  state: z.enum(["pending", "completed"]),
  commitment: ClientAcceptanceCommitmentSchema,
  completedAnchorSha256: z.string().regex(SHA256).nullable(),
};

const ClientAcceptanceEventV1BaseSchema = z.object({
  schemaVersion: z.literal(1),
  ...ClientAcceptanceEventCommonShape,
}).strict();

const ClientAcceptanceEventV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  ...ClientAcceptanceEventCommonShape,
  acceptanceRegistrationSha256: z.string().regex(SHA256),
}).strict();

const ClientAcceptanceEventBaseSchema = z.discriminatedUnion("schemaVersion", [
  ClientAcceptanceEventV1BaseSchema,
  ClientAcceptanceEventV2BaseSchema,
]);

const ClientAcceptanceEventSchema = z.discriminatedUnion("schemaVersion", [
  ClientAcceptanceEventV1BaseSchema.extend({ signature: z.string().regex(SHA256) }).strict(),
  ClientAcceptanceEventV2BaseSchema.extend({ signature: z.string().regex(SHA256) }).strict(),
]).superRefine((event, context) => {
  if ((event.state === "completed") !== (event.completedAnchorSha256 !== null)) {
    context.addIssue({ code: "custom", path: ["completedAnchorSha256"], message: "completed acceptance events require the completed anchor digest" });
  }
});

const AcceptanceRegistrationPredecessorSchema = z.object({
  sequence: z.number().int().positive(),
  headSha256: z.string().regex(SHA256),
  eventId: z.string().uuid(),
  eventSha256: z.string().regex(SHA256),
  state: z.enum(["pending", "completed"]),
  revisionId: z.string().uuid(),
  anchorId: z.string().uuid(),
}).strict();

const AcceptanceRegistrationCommonShape = {
  kind: z.literal("client-acceptance-registration"),
  projectId: z.string().uuid(),
  projectRegistrationSha256: z.string().regex(SHA256),
  revisionId: z.string().uuid(),
  deckRevision: z.number().int().positive(),
  anchorId: z.string().uuid(),
  transactionId: z.string().uuid(),
  pendingEventId: z.string().uuid(),
  commitment: ClientAcceptanceCommitmentSchema,
  predecessor: AcceptanceRegistrationPredecessorSchema.nullable(),
  registryPredecessor: z.object({
    version: z.number().int().positive(),
    stateSha256: z.string().regex(SHA256),
  }).strict().nullable(),
  registeredAt: z.string().datetime(),
};

const AcceptanceRegistrationV1BaseSchema = z.object({
  schemaVersion: z.literal(1),
  ...AcceptanceRegistrationCommonShape,
}).strict();

const AcceptanceRegistrationV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  ...AcceptanceRegistrationCommonShape,
  registrationSequence: z.number().int().positive(),
  legacyEvents: z.object({
    pendingEventSha256: z.string().regex(SHA256),
    completedEventSha256: z.string().regex(SHA256).nullable(),
  }).strict().nullable(),
}).strict();

const AcceptanceRegistrationBaseSchema = z.discriminatedUnion("schemaVersion", [
  AcceptanceRegistrationV1BaseSchema,
  AcceptanceRegistrationV2BaseSchema,
]);

const AcceptanceRegistrationSchema = z.discriminatedUnion("schemaVersion", [
  AcceptanceRegistrationV1BaseSchema.extend({ signature: z.string().regex(SHA256) }).strict(),
  AcceptanceRegistrationV2BaseSchema.extend({ signature: z.string().regex(SHA256) }).strict(),
]);

const ClientAcceptanceHeadBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("client-acceptance-head"),
  projectId: z.string().uuid(),
  sequence: z.number().int().positive(),
  eventId: z.string().uuid(),
  eventSha256: z.string().regex(SHA256),
  state: z.enum(["pending", "completed"]),
  transactionId: z.string().uuid(),
  predecessorHeadSha256: z.string().regex(SHA256).nullable(),
}).strict();

const ClientAcceptanceHeadSchema = ClientAcceptanceHeadBaseSchema.extend({
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
type ProjectRootAuthorityBase = z.infer<typeof ProjectRootAuthorityBaseSchema>;
type ProjectRootAuthority = z.infer<typeof ProjectRootAuthoritySchema>;
type ProjectRootAuthorityHeadBase = z.infer<typeof ProjectRootAuthorityHeadBaseSchema>;
type ProjectRootAuthorityHead = z.infer<typeof ProjectRootAuthorityHeadSchema>;
type ProjectRegistryStateV1Base = z.infer<typeof ProjectRegistryStateV1BaseSchema>;
type ProjectRegistryStateV2Base = z.infer<typeof ProjectRegistryStateV2BaseSchema>;
type ProjectRegistryState = z.infer<typeof ProjectRegistryStateSchema>;
type ClientAcceptanceEventBase = z.infer<typeof ClientAcceptanceEventBaseSchema>;
type ClientAcceptanceEvent = z.infer<typeof ClientAcceptanceEventSchema>;
type AcceptanceRegistrationBase = z.infer<typeof AcceptanceRegistrationBaseSchema>;
type AcceptanceRegistration = z.infer<typeof AcceptanceRegistrationSchema>;
type ClientAcceptanceHeadBase = z.infer<typeof ClientAcceptanceHeadBaseSchema>;
type ClientAcceptanceHead = z.infer<typeof ClientAcceptanceHeadSchema>;
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
      acceptanceHeads?: number;
      acceptanceEvents?: number;
      acceptanceRegistrations?: number;
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

function canonicalRootAuthority(value: ProjectRootAuthority): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalRootAuthorityHead(value: ProjectRootAuthorityHead): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalRegistryState(value: ProjectRegistryState): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalAcceptanceEvent(value: ClientAcceptanceEvent): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalAcceptanceHead(value: ClientAcceptanceHead): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalAcceptanceRegistration(value: AcceptanceRegistration): string {
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

function rootAuthorityVersionFilename(version: number): string {
  return `${String(version).padStart(16, "0")}.json`;
}

function acceptanceEventFilename(sequence: number, eventId: string): string {
  return `${String(sequence).padStart(16, "0")}-${eventId}.json`;
}

function acceptanceHeadFilename(sequence: number): string {
  return `${String(sequence).padStart(16, "0")}.json`;
}

function acceptanceRegistrationFilename(revisionId: string, anchorId: string): string {
  return `${revisionId}-${anchorId}.json`;
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
  const root = defaultTrustRoot();
  return {
    root: process.platform === "win32" ? await canonicalPotential(root) : root,
    deterministicKeySeed: "",
    operations: undefined,
  };
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
  const canonical = await realpath(absolute);
  if (info.isSymbolicLink() || !info.isDirectory() || canonical !== absolute) {
    throw new Error("trusted authorization directory is unsafe");
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error("trusted authorization directory must have mode 0700");
  }
  return absolute;
}

type TrustRoot = {
  root: string;
  deterministicKeySeed: string;
  operations: TestTrustConfiguration["operations"];
};

async function trustRootLocation(projectRoot: string): Promise<TrustRoot> {
  const canonicalProject = await canonicalProjectRoot(projectRoot);
  const configuration = await trustConfiguration(canonicalProject);
  const configuredRoot = resolve(configuration.root);
  const difference = relative(canonicalProject, configuredRoot);
  if (!difference || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))) {
    throw new Error("trusted authorization store must be outside the project root");
  }
  return {
    root: configuredRoot,
    deterministicKeySeed: configuration.deterministicKeySeed,
    operations: configuration.operations,
  };
}

async function assertExistingPrivateDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(absolute);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(absolute) !== absolute) {
    throw new Error(`${label} is unsafe`);
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must have mode 0700`);
  }
  return absolute;
}

async function existingTrustRoot(projectRoot: string): Promise<TrustRoot | null> {
  const location = await trustRootLocation(projectRoot);
  const kind = await pathKind(location.root);
  if (kind === "missing") return null;
  if (kind !== "directory") throw new Error("trusted authorization directory is unsafe");
  return { ...location, root: await assertExistingPrivateDirectory(location.root, "trusted authorization directory") };
}

async function trustRoot(projectRoot: string): Promise<TrustRoot> {
  const location = await trustRootLocation(projectRoot);
  const root = await ensurePrivateDirectory(location.root);
  await ensurePrivateDirectory(join(root, RECORDS_DIRECTORY));
  return {
    root,
    deterministicKeySeed: location.deterministicKeySeed,
    operations: location.operations,
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

async function replacePrivateExact(
  path: string,
  expected: Buffer,
  bytes: Buffer | string,
  checkpoint: GenerationAuthorizationTrustCheckpoint,
  publishedCheckpoint: GenerationAuthorizationTrustCheckpoint,
  operations?: TestTrustConfiguration["operations"],
): Promise<void> {
  const current = await readPrivateRegularFile(path, "trusted project root authority current head", MAX_ROOT_AUTHORITY_BYTES);
  if (!current.equals(expected)) throw new Error("trusted project root authority current head changed during update");
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(bytes, typeof bytes === "string" ? "utf8" : undefined);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations?.checkpoint?.(checkpoint);
    const rechecked = await readPrivateRegularFile(path, "trusted project root authority current head", MAX_ROOT_AUTHORITY_BYTES);
    if (!rechecked.equals(expected)) throw new Error("trusted project root authority current head changed during update");
    await rename(temporary, path);
    await syncDirectory(parent);
    await operations?.checkpoint?.(publishedCheckpoint);
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
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
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

function signedRootAuthority(key: Buffer, base: ProjectRootAuthorityBase): ProjectRootAuthority {
  const parsed = ProjectRootAuthorityBaseSchema.parse(base);
  return ProjectRootAuthoritySchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertRootAuthoritySignature(key: Buffer, authority: ProjectRootAuthority): void {
  const { signature, ...base } = authority;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(ProjectRootAuthorityBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted project root authority signature is invalid");
  }
}

function signedRootAuthorityHead(key: Buffer, base: ProjectRootAuthorityHeadBase): ProjectRootAuthorityHead {
  const parsed = ProjectRootAuthorityHeadBaseSchema.parse(base);
  return ProjectRootAuthorityHeadSchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertRootAuthorityHeadSignature(key: Buffer, head: ProjectRootAuthorityHead): void {
  const { signature, ...base } = head;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(ProjectRootAuthorityHeadBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted project root authority current head signature is invalid");
  }
}

function signedRegistryState(key: Buffer, base: ProjectRegistryStateV2Base): ProjectRegistryState {
  const parsed = ProjectRegistryStateV2BaseSchema.parse(base);
  return ProjectRegistryStateV2Schema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertRegistryStateSignature(key: Buffer, state: ProjectRegistryState): void {
  const { signature, ...base } = state;
  const actual = Buffer.from(signature, "hex");
  const parsed = state.schemaVersion === 1
    ? ProjectRegistryStateV1BaseSchema.parse(base) satisfies ProjectRegistryStateV1Base
    : ProjectRegistryStateV2BaseSchema.parse(base) satisfies ProjectRegistryStateV2Base;
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(parsed))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted project registry state signature is invalid");
  }
}

function signedAcceptanceEvent(key: Buffer, base: ClientAcceptanceEventBase): ClientAcceptanceEvent {
  const parsed = ClientAcceptanceEventBaseSchema.parse(base);
  return ClientAcceptanceEventSchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function signedAcceptanceRegistration(key: Buffer, base: AcceptanceRegistrationBase): AcceptanceRegistration {
  const parsed = AcceptanceRegistrationBaseSchema.parse(base);
  return AcceptanceRegistrationSchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertAcceptanceRegistrationSignature(key: Buffer, registration: AcceptanceRegistration): void {
  const { signature, ...base } = registration;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(AcceptanceRegistrationBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted client acceptance registration signature is invalid");
  }
}

function assertAcceptanceEventSignature(key: Buffer, event: ClientAcceptanceEvent): void {
  const { signature, ...base } = event;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(ClientAcceptanceEventBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted client acceptance event signature is invalid");
  }
}

function signedAcceptanceHead(key: Buffer, base: ClientAcceptanceHeadBase): ClientAcceptanceHead {
  const parsed = ClientAcceptanceHeadBaseSchema.parse(base);
  return ClientAcceptanceHeadSchema.parse({
    ...parsed,
    signature: createHmac("sha256", key).update(JSON.stringify(parsed)).digest("hex"),
  });
}

function assertAcceptanceHeadSignature(key: Buffer, head: ClientAcceptanceHead): void {
  const { signature, ...base } = head;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", key)
    .update(JSON.stringify(ClientAcceptanceHeadBaseSchema.parse(base)))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("trusted client acceptance head signature is invalid");
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
  clientAcceptance: ProjectHighWater | null;
  storeRoot: string;
  key: Buffer;
  statesRoot: string;
};

function registrationPath(storeRoot: string, projectId: string): string {
  return join(storeRoot, PROJECT_REGISTRATIONS_DIRECTORY, `${projectId}.json`);
}

function acceptanceRegistrationRoot(storeRoot: string, projectId: string): string {
  return join(storeRoot, PROJECT_REGISTRATIONS_DIRECTORY, projectId, "acceptances");
}

function registryRoots(storeRoot: string, projectId: string): { root: string; states: string } {
  const root = join(storeRoot, PROJECT_REGISTRY_DIRECTORY, projectId);
  return { root, states: join(root, REGISTRY_STATES_DIRECTORY) };
}

function rootAuthorityRoots(storeRoot: string, projectId: string): {
  root: string;
  states: string;
  heads: string;
  current: string;
} {
  const root = join(storeRoot, PROJECT_REGISTRATIONS_DIRECTORY, projectId, ROOT_AUTHORITY_DIRECTORY);
  return {
    root,
    states: join(root, ROOT_AUTHORITY_STATES_DIRECTORY),
    heads: join(root, ROOT_AUTHORITY_HEADS_DIRECTORY),
    current: join(root, ROOT_AUTHORITY_CURRENT_FILE),
  };
}

type RootAuthoritySnapshot = {
  baseRegistration: ProjectRegistration;
  baseRegistrationSha256: string;
  authority: ProjectRootAuthority;
  authoritySha256: string;
  head: ProjectRootAuthorityHead;
  headSha256: string;
  currentBytes: Buffer;
  roots: ReturnType<typeof rootAuthorityRoots>;
};

async function parseRootAuthorityFile(
  path: string,
  key: Buffer,
  projectId: string,
): Promise<{ authority: ProjectRootAuthority; sha256: string; bytes: Buffer }> {
  const bytes = await readPrivateRegularFile(path, "trusted project root authority", MAX_ROOT_AUTHORITY_BYTES);
  let authority: ProjectRootAuthority;
  try {
    authority = ProjectRootAuthoritySchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalRootAuthority(authority) !== bytes.toString("utf8")) throw new Error("root authority is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted project root authority is invalid or tampered", { cause: error });
  }
  assertRootAuthoritySignature(key, authority);
  if (authority.projectId !== projectId) throw new Error("trusted project root authority belongs to a different project");
  return { authority, sha256: sha256(bytes), bytes };
}

async function parseRootAuthorityHeadFile(
  path: string,
  key: Buffer,
  projectId: string,
): Promise<{ head: ProjectRootAuthorityHead; sha256: string; bytes: Buffer }> {
  const bytes = await readPrivateRegularFile(path, "trusted project root authority current head", MAX_ROOT_AUTHORITY_BYTES);
  let head: ProjectRootAuthorityHead;
  try {
    head = ProjectRootAuthorityHeadSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalRootAuthorityHead(head) !== bytes.toString("utf8")) throw new Error("root authority head is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted project root authority current head is invalid or tampered", { cause: error });
  }
  assertRootAuthorityHeadSignature(key, head);
  if (head.projectId !== projectId) throw new Error("trusted project root authority current head belongs to a different project");
  return { head, sha256: sha256(bytes), bytes };
}

async function readRootAuthority(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
  options: { allowMissing?: boolean; allowRecoveryTail?: boolean } = {},
): Promise<RootAuthoritySnapshot | null> {
  assertGenerationLeaseHeld(projectRoot);
  const base = await parseRegistrationFile(registrationPath(storeRoot, projectId), key, projectId);
  const roots = rootAuthorityRoots(storeRoot, projectId);
  const rootKind = await pathKind(roots.root);
  if (rootKind === "missing") {
    if (options.allowMissing) return null;
    throw new Error("trusted project root authority is missing; explicit trust migration is required");
  }
  if (rootKind !== "directory") throw new Error("trusted project root authority directory is unsafe");
  await assertExistingPrivateDirectory(roots.root, "trusted project root authority directory");
  await assertExistingPrivateDirectory(roots.states, "trusted project root authority state directory");
  await assertExistingPrivateDirectory(roots.heads, "trusted project root authority head directory");
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
  const stateNames = await readBoundedPrivateDirectory(
    roots.states,
    "trusted project root authority state directory",
    MAX_ROOT_AUTHORITY_STATES,
    (name) => /^\d{16}\.json$/.test(name) ? "include" : "reject",
  );
  const headNames = await readBoundedPrivateDirectory(
    roots.heads,
    "trusted project root authority head directory",
    MAX_ROOT_AUTHORITY_STATES,
    (name) => /^\d{16}\.json$/.test(name) ? "include" : "reject",
  );
  stateNames.sort();
  headNames.sort();
  if (
    stateNames.length === 0
    || headNames.length === 0
    || stateNames.length < headNames.length
    || stateNames.length > headNames.length + 1
  ) throw new Error("trusted project root authority history is missing, truncated, or forked");
  const states: Array<Awaited<ReturnType<typeof parseRootAuthorityFile>>> = [];
  let previousAuthoritySha256 = base.sha256;
  for (const [index, name] of stateNames.entries()) {
    const version = index + 1;
    if (name !== rootAuthorityVersionFilename(version)) {
      throw new Error("trusted project root authority state sequence is not contiguous");
    }
    const parsed = await parseRootAuthorityFile(join(roots.states, name), key, projectId);
    if (
      parsed.authority.version !== version
      || parsed.authority.baseRegistrationSha256 !== base.sha256
      || parsed.authority.predecessorAuthoritySha256 !== previousAuthoritySha256
    ) throw new Error("trusted project root authority predecessor is broken or forked");
    previousAuthoritySha256 = parsed.sha256;
    states.push(parsed);
  }
  const heads: Array<Awaited<ReturnType<typeof parseRootAuthorityHeadFile>>> = [];
  let previousHeadSha256: string | null = null;
  for (const [index, name] of headNames.entries()) {
    const version = index + 1;
    if (name !== rootAuthorityVersionFilename(version)) {
      throw new Error("trusted project root authority head sequence is not contiguous");
    }
    const parsed = await parseRootAuthorityHeadFile(join(roots.heads, name), key, projectId);
    if (
      parsed.head.version !== version
      || parsed.head.authoritySha256 !== states[index]!.sha256
      || parsed.head.predecessorHeadSha256 !== previousHeadSha256
    ) throw new Error("trusted project root authority head predecessor is broken or forked");
    previousHeadSha256 = parsed.sha256;
    heads.push(parsed);
  }
  const current = await parseRootAuthorityHeadFile(roots.current, key, projectId);
  const currentHistory = heads[current.head.version - 1];
  if (!currentHistory || !current.bytes.equals(currentHistory.bytes)) {
    throw new Error("trusted project root authority current head is downgraded or inconsistent");
  }
  const hasRecoveryTail = stateNames.length !== headNames.length || current.head.version !== headNames.length;
  if (hasRecoveryTail && !options.allowRecoveryTail) {
    throw new Error("trusted project root authority publication recovery is required");
  }
  if (
    options.allowRecoveryTail
    && (headNames.length > current.head.version + 1 || stateNames.length > current.head.version + 1)
  ) throw new Error("trusted project root authority recovery tail is ambiguous or forked");
  const authority = states[current.head.version - 1]!;
  return {
    baseRegistration: base.registration,
    baseRegistrationSha256: base.sha256,
    authority: authority.authority,
    authoritySha256: authority.sha256,
    head: current.head,
    headSha256: current.sha256,
    currentBytes: current.bytes,
    roots,
  };
}

async function initializeRootAuthorityForNewRegistration(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
): Promise<RootAuthoritySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const base = await parseRegistrationFile(registrationPath(storeRoot, projectId), key, projectId);
  const roots = rootAuthorityRoots(storeRoot, projectId);
  await ensurePrivateDirectory(roots.root);
  await ensurePrivateDirectory(roots.states);
  await ensurePrivateDirectory(roots.heads);
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
  const authority = signedRootAuthority(key, {
    schemaVersion: 2,
    kind: "generation-project-registration-authority",
    projectId,
    baseRegistrationSha256: base.sha256,
    version: 1,
    predecessorAuthoritySha256: base.sha256,
    clientAcceptance: {
      initialized: false,
      registrationSequence: 0,
      registrationSha256: null,
      registrationSetSha256: null,
      chain: null,
    },
  });
  const authorityBytes = canonicalRootAuthority(authority);
  const authorityPath = join(roots.states, rootAuthorityVersionFilename(1));
  if (!await writePrivateExclusive(authorityPath, authorityBytes)) {
    const existing = await readPrivateRegularFile(authorityPath, "trusted project root authority", MAX_ROOT_AUTHORITY_BYTES);
    if (!existing.equals(Buffer.from(authorityBytes))) throw new Error("trusted project root authority initialization conflicts");
  }
  const head = signedRootAuthorityHead(key, {
    schemaVersion: 1,
    kind: "generation-project-registration-authority-head",
    projectId,
    version: 1,
    authoritySha256: sha256(authorityBytes),
    predecessorHeadSha256: null,
  });
  const headBytes = canonicalRootAuthorityHead(head);
  const headPath = join(roots.heads, rootAuthorityVersionFilename(1));
  if (!await writePrivateExclusive(headPath, headBytes)) {
    const existing = await readPrivateRegularFile(headPath, "trusted project root authority head", MAX_ROOT_AUTHORITY_BYTES);
    if (!existing.equals(Buffer.from(headBytes))) throw new Error("trusted project root authority head initialization conflicts");
  }
  if (!await writePrivateExclusive(roots.current, headBytes)) {
    const existing = await readPrivateRegularFile(roots.current, "trusted project root authority current head", MAX_ROOT_AUTHORITY_BYTES);
    if (!existing.equals(Buffer.from(headBytes))) throw new Error("trusted project root authority current head initialization conflicts");
  }
  return (await readRootAuthority(projectRoot, projectId, storeRoot, key))!;
}

type RootAuthorityAdvancePhase = "registration" | "pending" | "completed";

function authorityCheckpoint(
  phase: RootAuthorityAdvancePhase,
  part: "state-temp-synced" | "state-published" | "head-temp-synced" | "head-published" | "current-temp-synced" | "current-published",
): GenerationAuthorizationTrustCheckpoint {
  return `acceptance-authority-${phase}-${part}` as GenerationAuthorizationTrustCheckpoint;
}

async function advanceRootAuthority(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
  clientAcceptance: z.infer<typeof RootAcceptanceAuthoritySchema>,
  phase: RootAuthorityAdvancePhase,
): Promise<RootAuthoritySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const current = await readRootAuthority(projectRoot, projectId, storeRoot, key, { allowRecoveryTail: true });
  if (!current) throw new Error("trusted project root authority is missing; explicit trust migration is required");
  if (JSON.stringify(current.authority.clientAcceptance) === JSON.stringify(clientAcceptance)) {
    return (await readRootAuthority(projectRoot, projectId, storeRoot, key))!;
  }
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
  const authority = signedRootAuthority(key, {
    schemaVersion: 2,
    kind: "generation-project-registration-authority",
    projectId,
    baseRegistrationSha256: current.baseRegistrationSha256,
    version: current.authority.version + 1,
    predecessorAuthoritySha256: current.authoritySha256,
    clientAcceptance: RootAcceptanceAuthoritySchema.parse(clientAcceptance),
  });
  const authorityBytes = canonicalRootAuthority(authority);
  const authorityPath = join(current.roots.states, rootAuthorityVersionFilename(authority.version));
  if (!await writePrivateExclusive(
    authorityPath,
    authorityBytes,
    authorityCheckpoint(phase, "state-temp-synced"),
    store.operations,
  )) {
    const existing = await readPrivateRegularFile(authorityPath, "trusted project root authority", MAX_ROOT_AUTHORITY_BYTES);
    if (!existing.equals(Buffer.from(authorityBytes))) throw new Error("trusted project root authority recovery conflicts");
  }
  await store.operations?.checkpoint?.(authorityCheckpoint(phase, "state-published"));
  const head = signedRootAuthorityHead(key, {
    schemaVersion: 1,
    kind: "generation-project-registration-authority-head",
    projectId,
    version: authority.version,
    authoritySha256: sha256(authorityBytes),
    predecessorHeadSha256: current.headSha256,
  });
  const headBytes = canonicalRootAuthorityHead(head);
  const headPath = join(current.roots.heads, rootAuthorityVersionFilename(head.version));
  if (!await writePrivateExclusive(
    headPath,
    headBytes,
    authorityCheckpoint(phase, "head-temp-synced"),
    store.operations,
  )) {
    const existing = await readPrivateRegularFile(headPath, "trusted project root authority head", MAX_ROOT_AUTHORITY_BYTES);
    if (!existing.equals(Buffer.from(headBytes))) throw new Error("trusted project root authority head recovery conflicts");
  }
  await store.operations?.checkpoint?.(authorityCheckpoint(phase, "head-published"));
  await replacePrivateExact(
    current.roots.current,
    current.currentBytes,
    headBytes,
    authorityCheckpoint(phase, "current-temp-synced"),
    authorityCheckpoint(phase, "current-published"),
    store.operations,
  );
  return (await readRootAuthority(projectRoot, projectId, storeRoot, key))!;
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

async function parseAcceptanceRegistrationFile(
  path: string,
  key: Buffer,
  projectId: string,
  projectRegistrationSha256: string,
): Promise<{ registration: AcceptanceRegistration; sha256: string }> {
  const bytes = await readPrivateRegularFile(
    path,
    "trusted client acceptance registration",
    MAX_ACCEPTANCE_REGISTRATION_BYTES,
  );
  let registration: AcceptanceRegistration;
  try {
    registration = AcceptanceRegistrationSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalAcceptanceRegistration(registration) !== bytes.toString("utf8")) {
      throw new Error("acceptance registration is not canonical");
    }
  } catch (error: unknown) {
    throw new Error("trusted client acceptance registration is invalid or tampered", { cause: error });
  }
  assertAcceptanceRegistrationSignature(key, registration);
  if (
    registration.projectId !== projectId
    || registration.projectRegistrationSha256 !== projectRegistrationSha256
    || basename(path) !== acceptanceRegistrationFilename(registration.revisionId, registration.anchorId)
    || registration.commitment.projectId !== projectId
    || registration.commitment.revisionId !== registration.revisionId
    || registration.commitment.deckRevision !== registration.deckRevision
    || registration.commitment.anchorId !== registration.anchorId
    || registration.commitment.transactionId !== registration.transactionId
  ) throw new Error("trusted client acceptance registration binding is invalid or forked");
  return { registration, sha256: sha256(bytes) };
}

type AcceptanceRegistrationEntry = {
  registration: AcceptanceRegistration;
  sha256: string;
};

async function readAcceptanceRegistrations(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
): Promise<AcceptanceRegistrationEntry[]> {
  assertGenerationLeaseHeld(projectRoot);
  const root = acceptanceRegistrationRoot(storeRoot, projectId);
  const kind = await pathKind(root);
  if (kind === "missing") return [];
  if (kind !== "directory") throw new Error("trusted client acceptance registration directory is unsafe");
  await assertExistingPrivateDirectory(root, "trusted client acceptance registration directory");
  const base = await parseRegistrationFile(registrationPath(storeRoot, projectId), key, projectId);
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
  const names = await readBoundedPrivateDirectory(
    root,
    "trusted client acceptance registration directory",
    store.operations?.limits?.acceptanceRegistrations ?? MAX_ACCEPTANCE_REGISTRATIONS,
    (name) => /^[0-9a-f-]{36}-[0-9a-f-]{36}\.json$/i.test(name) ? "include" : "reject",
  );
  const entries = await Promise.all(names.sort().map((name) =>
    parseAcceptanceRegistrationFile(join(root, name), key, projectId, base.sha256)));
  const transactionIds = new Set<string>();
  const revisionIds = new Set<string>();
  const anchorIds = new Set<string>();
  for (const { registration } of entries) {
    if (
      transactionIds.has(registration.transactionId)
      || revisionIds.has(registration.revisionId)
      || anchorIds.has(registration.anchorId)
    ) throw new Error("trusted client acceptance registrations are duplicated or forked");
    transactionIds.add(registration.transactionId);
    revisionIds.add(registration.revisionId);
    anchorIds.add(registration.anchorId);
  }
  entries.sort((left, right) => {
    const leftSequence = left.registration.schemaVersion === 2
      ? left.registration.registrationSequence
      : (left.registration.predecessor?.sequence ?? 0) / 2 + 1;
    const rightSequence = right.registration.schemaVersion === 2
      ? right.registration.registrationSequence
      : (right.registration.predecessor?.sequence ?? 0) / 2 + 1;
    return leftSequence - rightSequence;
  });
  for (const [index, { registration }] of entries.entries()) {
    if (registration.schemaVersion === 2 && registration.registrationSequence !== index + 1) {
      throw new Error("trusted client acceptance registration high-water is not contiguous");
    }
  }
  return entries;
}

function acceptanceRegistrationSetAuthority(
  entries: AcceptanceRegistrationEntry[],
  chain: RootAuthoritySnapshot["authority"]["clientAcceptance"]["chain"],
): z.infer<typeof RootAcceptanceAuthoritySchema> {
  if (entries.length === 0) {
    return {
      initialized: false,
      registrationSequence: 0,
      registrationSha256: null,
      registrationSetSha256: null,
      chain: null,
    };
  }
  return RootAcceptanceAuthoritySchema.parse({
    initialized: true,
    registrationSequence: entries.length,
    registrationSha256: entries.at(-1)!.sha256,
    registrationSetSha256: sha256(JSON.stringify(entries.map(({ sha256: registrationSha256 }, index) => ({
      sequence: index + 1,
      registrationSha256,
    })))),
    chain,
  });
}

async function commitAcceptanceRegistrationSetAuthority(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
): Promise<RootAuthoritySnapshot> {
  const entries = await readAcceptanceRegistrations(projectRoot, projectId, storeRoot, key);
  const root = await readRootAuthority(projectRoot, projectId, storeRoot, key, { allowRecoveryTail: true });
  if (!root) throw new Error("trusted project root authority is missing; explicit trust migration is required");
  const desired = acceptanceRegistrationSetAuthority(entries, root.authority.clientAcceptance.chain);
  const current = root.authority.clientAcceptance;
  if (
    current.initialized === desired.initialized
    && current.registrationSequence === desired.registrationSequence
    && current.registrationSha256 === desired.registrationSha256
    && current.registrationSetSha256 === desired.registrationSetSha256
  ) return root;
  return advanceRootAuthority(
    projectRoot,
    projectId,
    storeRoot,
    key,
    desired,
    "registration",
  );
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
    join(storeRoot, CLIENT_ACCEPTANCE_DIRECTORY, projectId),
    acceptanceRegistrationRoot(storeRoot, projectId),
    rootAuthorityRoots(storeRoot, projectId).root,
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
  allowMissingRootAuthority = false,
  allowRootAuthorityRecoveryTail = false,
): Promise<ProjectRegistrySnapshot | null> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
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
  await readRootAuthority(projectRoot, projectId, storeRoot, key, {
    allowMissing: allowMissingRootAuthority,
    allowRecoveryTail: allowRootAuthorityRecoveryTail,
  });
  const roots = registryRoots(storeRoot, projectId);
  const rootKind = await pathKind(roots.root);
  if (rootKind === "missing") throw new Error("registered project registry is missing");
  if (rootKind !== "directory") throw new Error("trusted project registry is unsafe");
  await assertExistingPrivateDirectory(roots.root, "trusted project registry");
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
      clientAcceptance: null,
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
    clientAcceptance: latest?.state.schemaVersion === 2 ? latest.state.clientAcceptance : null,
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
  allowRootAuthorityRecoveryTail = false,
): Promise<ProjectRegistrySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const markerKind = await pathKind(registrationPath(storeRoot, projectId));
  const roots = registryRoots(storeRoot, projectId);
  const registryKind = await pathKind(roots.root);
  if (markerKind === "file" && registryKind === "missing") {
    const authority = await readRootAuthority(projectRoot, projectId, storeRoot, key);
    if (authority?.authority.clientAcceptance.initialized) {
      throw new Error("trusted project registry is missing below the project root authority high-water");
    }
    const initializedSubtrees = [
      join(storeRoot, AUTHORIZATION_HEADS_DIRECTORY, projectId),
      join(storeRoot, CALL_LEDGERS_DIRECTORY, projectId),
      join(storeRoot, CLIENT_ACCEPTANCE_DIRECTORY, projectId),
    ];
    if ((await Promise.all(initializedSubtrees.map(pathKind))).some((kind) => kind !== "missing")) {
      throw new Error("registered project registry is missing");
    }
    await ensurePrivateDirectory(roots.root);
  }
  const existing = await readProjectRegistry(
    projectRoot,
    projectId,
    storeRoot,
    key,
    false,
    allowRootAuthorityRecoveryTail,
  );
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
  await initializeRootAuthorityForNewRegistration(projectRoot, projectId, storeRoot, key);
  await ensurePrivateDirectory(roots.root);
  const initialized = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
  if (!initialized) throw new Error("trusted project registry initialization did not converge");
  return initialized;
}

async function appendProjectRegistryState(
  projectRoot: string,
  current: ProjectRegistrySnapshot,
  next: {
    authorization: ProjectHighWater | null;
    calls: ProjectHighWater | null;
    clientAcceptance: ProjectHighWater | null;
  },
): Promise<ProjectRegistrySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  await ensurePrivateDirectory(current.statesRoot);
  const state = signedRegistryState(current.key, {
    schemaVersion: 2,
    kind: "generation-project-high-water",
    projectId: current.registration.projectId,
    registrationSha256: current.registrationSha256,
    version: (current.state?.version ?? 0) + 1,
    predecessorStateSha256: current.stateSha256 ?? current.registrationSha256,
    authorization: next.authorization,
    calls: next.calls,
    clientAcceptance: next.clientAcceptance,
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
  kind: "authorization" | "calls" | "clientAcceptance",
  actual: ProjectHighWater | null,
): Promise<ProjectRegistrySnapshot> {
  assertGenerationLeaseHeld(projectRoot);
  if (!registryHighWaterNeedsAdvance(registry[kind], kind, actual)) return registry;
  const store = await trustRoot(projectRoot);
  await store.operations?.checkpoint?.(kind === "authorization"
    ? "registry-before-authorization-advance"
    : kind === "calls"
      ? "registry-before-call-advance"
      : "registry-before-acceptance-advance");
  return appendProjectRegistryState(projectRoot, registry, {
    authorization: kind === "authorization" ? actual : registry.authorization,
    calls: kind === "calls" ? actual : registry.calls,
    clientAcceptance: kind === "clientAcceptance" ? actual : registry.clientAcceptance,
  });
}

function registryHighWaterNeedsAdvance(
  expected: ProjectHighWater | null,
  kind: "authorization" | "calls" | "clientAcceptance",
  actual: ProjectHighWater | null,
): boolean {
  if (expected && !actual) throw new Error(`trusted ${kind} history is missing below the project registry high-water`);
  if (!actual) return false;
  if (expected) {
    if (actual.sequence < expected.sequence) throw new Error(`trusted ${kind} history is truncated below the project registry high-water`);
    if (actual.sequence === expected.sequence) {
      if (actual.headSha256 !== expected.headSha256) throw new Error(`trusted ${kind} head does not match the project registry high-water`);
      return false;
    }
    if (actual.sequence !== expected.sequence + 1) throw new Error(`trusted ${kind} history is ahead of the project registry by more than one transition`);
  } else {
    const initialSequence = kind === "calls" ? 0 : 1;
    if (actual.sequence !== initialSequence) throw new Error(`trusted ${kind} history cannot initialize the project registry high-water`);
  }
  return true;
}

type ClientAcceptanceChainEntry = {
  event: ClientAcceptanceEvent;
  eventSha256: string;
  head: ClientAcceptanceHead;
  headSha256: string;
};

function rootAcceptanceChainHighWater(
  current: ClientAcceptanceChainEntry | undefined,
): RootAuthoritySnapshot["authority"]["clientAcceptance"]["chain"] {
  return current ? {
    sequence: current.head.sequence,
    headSha256: current.headSha256,
    state: current.event.state,
  } : null;
}

async function commitAcceptanceChainRootAuthority(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
  current: ClientAcceptanceChainEntry,
): Promise<void> {
  const entries = await readAcceptanceRegistrations(projectRoot, projectId, storeRoot, key);
  await advanceRootAuthority(
    projectRoot,
    projectId,
    storeRoot,
    key,
    acceptanceRegistrationSetAuthority(entries, rootAcceptanceChainHighWater(current)),
    current.event.state,
  );
}

async function assertAcceptanceRootAuthorityReconciled(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
  chain: ClientAcceptanceChainEntry[],
): Promise<void> {
  const root = await readRootAuthority(projectRoot, projectId, storeRoot, key);
  if (!root) throw new Error("trusted project root authority is missing; explicit trust migration is required");
  const entries = await readAcceptanceRegistrations(projectRoot, projectId, storeRoot, key);
  const expected = acceptanceRegistrationSetAuthority(entries, rootAcceptanceChainHighWater(chain.at(-1)));
  if (JSON.stringify(root.authority.clientAcceptance) !== JSON.stringify(expected)) {
    throw new Error("trusted project root authority registration set or acceptance high-water is inconsistent; trust recovery is required");
  }
}

function acceptanceRoots(storeRoot: string, projectId: string): {
  root: string;
  events: string;
  heads: string;
} {
  const root = join(storeRoot, CLIENT_ACCEPTANCE_DIRECTORY, projectId);
  return {
    root,
    events: join(root, ACCEPTANCE_EVENTS_DIRECTORY),
    heads: join(root, ACCEPTANCE_HEADS_DIRECTORY),
  };
}

function sameCommitment(left: ClientAcceptanceTransaction, right: ClientAcceptanceTransaction): boolean {
  return JSON.stringify(ClientAcceptanceCommitmentSchema.parse(left))
    === JSON.stringify(ClientAcceptanceCommitmentSchema.parse(right));
}

function manifestHasAcceptanceEvidence(manifest: ProjectManifest): boolean {
  return Boolean(
    manifest.clientAcceptanceTransaction
    || manifest.clientSmokeCopyAnchor
    || manifest.stage === "delivered"
    || manifest.exports.acceptance?.path.endsWith("/acceptance-record.json"),
  );
}

function missingTrustRootError(): Error {
  return new Error("local client acceptance evidence has no external trust root; explicit trust migration or recovery is required");
}

function acceptanceRegistrationPredecessor(
  current: ClientAcceptanceChainEntry | undefined,
): AcceptanceRegistration["predecessor"] {
  return current ? {
    sequence: current.head.sequence,
    headSha256: current.headSha256,
    eventId: current.event.eventId,
    eventSha256: current.eventSha256,
    state: current.event.state,
    revisionId: current.event.commitment.revisionId,
    anchorId: current.event.commitment.anchorId,
  } : null;
}

function registryPredecessor(
  registry: ProjectRegistrySnapshot,
): AcceptanceRegistration["registryPredecessor"] {
  return registry.state && registry.stateSha256
    ? { version: registry.state.version, stateSha256: registry.stateSha256 }
    : null;
}

async function assertStrictRevisionDescent(
  projectRoot: string,
  manifest: ProjectManifest,
  ancestorRevisionId: string,
): Promise<ProjectManifest> {
  const ancestorIndex = manifest.revisions.findIndex(({ id }) => id === ancestorRevisionId);
  const currentIndex = manifest.revisions.findIndex(({ id }) => id === manifest.currentRevision.id);
  if (ancestorIndex < 0 || currentIndex !== manifest.revisions.length - 1 || currentIndex <= ancestorIndex) {
    throw new Error("new client acceptance requires a strictly newer descendant revision");
  }
  let ancestorManifest: ProjectManifest | null = null;
  for (let index = ancestorIndex + 1; index <= currentIndex; index += 1) {
    const parent = manifest.revisions[index - 1]!;
    const revision = manifest.revisions[index]!;
    const snapshot = await readRevisionSnapshot(projectRoot, parent.id);
    if (
      revision.parentId !== parent.id
      || revision.number !== parent.number + 1
      || revision.parentSnapshotDescriptorSha256 !== snapshot.descriptor.descriptorSha256
      || snapshot.manifest.currentRevision.id !== parent.id
      || JSON.stringify(snapshot.manifest.revisions) !== JSON.stringify(manifest.revisions.slice(0, index))
    ) {
      throw new Error("new client acceptance revision ancestry is invalid or reordered");
    }
    if (index === ancestorIndex + 1) ancestorManifest = snapshot.manifest;
  }
  if (!ancestorManifest) throw new Error("new client acceptance ancestor snapshot is missing");
  return ancestorManifest;
}

async function assertCompletedAcceptanceManifest(
  projectRoot: string,
  manifest: ProjectManifest,
  completed: ClientAcceptanceChainEntry,
): Promise<void> {
  const transaction = completed.event.commitment;
  const sameRevision = manifest.currentRevision.id === transaction.revisionId;
  const acceptanceBase = sameRevision
    ? manifest
    : await assertStrictRevisionDescent(projectRoot, manifest, transaction.revisionId);
  const anchor = acceptanceBase.clientSmokeCopyAnchor;
  const completedAnchor = sameRevision ? anchor : anchor ? {
    ...anchor,
    state: "completed" as const,
    observation: transaction.observation,
    reopenedCopySha256: transaction.reopenedCopySha256,
    acceptanceRecord: transaction.acceptanceRecord,
    completedAt: transaction.confirmedAt,
  } : undefined;
  if (
    completed.event.state !== "completed"
    || !completed.event.completedAnchorSha256
    || acceptanceBase.currentRevision.id !== transaction.revisionId
    || acceptanceBase.clientAcceptanceTransaction !== undefined
    || !anchor
    || !completedAnchor
    || (sameRevision ? acceptanceBase.stage !== "delivered" : anchor.state !== "ready")
    || (sameRevision && JSON.stringify(acceptanceBase.exports.acceptance) !== JSON.stringify(transaction.acceptanceRecord))
    || completedAnchor.projectId !== transaction.projectId
    || completedAnchor.revisionId !== transaction.revisionId
    || completedAnchor.deckRevision !== transaction.deckRevision
    || completedAnchor.anchorId !== transaction.anchorId
    || JSON.stringify(completedAnchor.descriptor) !== JSON.stringify(transaction.descriptor)
    || JSON.stringify(completedAnchor.source) !== JSON.stringify(transaction.source)
    || JSON.stringify(completedAnchor.initialCopy) !== JSON.stringify(transaction.initialCopy)
    || JSON.stringify(completedAnchor.observation) !== JSON.stringify(transaction.observation)
    || completedAnchor.reopenedCopySha256 !== transaction.reopenedCopySha256
    || JSON.stringify(completedAnchor.acceptanceRecord) !== JSON.stringify(transaction.acceptanceRecord)
    || completedAnchor.completedAt !== transaction.confirmedAt
    || sha256(Buffer.from(JSON.stringify(completedAnchor))) !== completed.event.completedAnchorSha256
  ) throw new Error("project mutations are frozen because completed client acceptance is not current");
  for (const artifact of [transaction.observation, transaction.acceptanceRecord]) {
    const bytes = await readOwnedRegularFile(projectRoot, artifact.path);
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error("project mutations are frozen because completed client acceptance evidence changed");
    }
  }
}

async function ensurePendingAcceptanceRegistration(
  projectRoot: string,
  manifest: ProjectManifest,
  storeRoot: string,
  key: Buffer,
  registry: ProjectRegistrySnapshot,
  current: ClientAcceptanceChainEntry | undefined,
  transaction: ClientAcceptanceTransaction,
): Promise<AcceptanceRegistrationEntry> {
  assertGenerationLeaseHeld(projectRoot);
  const registrations = await readAcceptanceRegistrations(projectRoot, manifest.projectId, storeRoot, key);
  const expectedPredecessor = acceptanceRegistrationPredecessor(current);
  const existing = registrations.find(({ registration }) =>
    registration.revisionId === transaction.revisionId
    || registration.anchorId === transaction.anchorId
    || registration.transactionId === transaction.transactionId);
  if (existing) {
    const represented = current?.event.schemaVersion === 2
      ? current.event.acceptanceRegistrationSha256 === existing.sha256
      : Boolean(current
        && current.event.state === "pending"
        && existing.registration.pendingEventId === current.event.eventId
        && (existing.registration.schemaVersion === 1
          || existing.registration.legacyEvents?.pendingEventSha256 === current.eventSha256));
    if (
      !sameCommitment(existing.registration.commitment, transaction)
      || (!represented
        && JSON.stringify(existing.registration.predecessor) !== JSON.stringify(expectedPredecessor))
    ) throw new Error("trusted client acceptance registration conflicts with immutable first write");
    if (
      !represented
      && JSON.stringify(existing.registration.registryPredecessor) !== JSON.stringify(registryPredecessor(registry))
    ) throw new Error("trusted client acceptance registration exposes a truncated registry predecessor");
    await commitAcceptanceRegistrationSetAuthority(projectRoot, manifest.projectId, storeRoot, key);
    return existing;
  }
  if (current?.event.state === "pending") {
    throw new Error("trusted client acceptance commitment does not match immutable first write");
  }
  if (current?.event.state === "completed") {
    if (transaction.anchorId === current.event.commitment.anchorId) {
      throw new Error("completed client acceptance anchor cannot be superseded");
    }
    await assertStrictRevisionDescent(projectRoot, manifest, current.event.commitment.revisionId);
  }
  if (manifest.currentRevision.id !== transaction.revisionId) {
    throw new Error("trusted client acceptance registration does not bind the current revision");
  }
  const baseRegistration = await parseRegistrationFile(
    registrationPath(storeRoot, manifest.projectId),
    key,
    manifest.projectId,
  );
  const registration = signedAcceptanceRegistration(key, {
    schemaVersion: 2,
    kind: "client-acceptance-registration",
    projectId: manifest.projectId,
    projectRegistrationSha256: baseRegistration.sha256,
    revisionId: transaction.revisionId,
    deckRevision: transaction.deckRevision,
    anchorId: transaction.anchorId,
    transactionId: transaction.transactionId,
    pendingEventId: randomUUID(),
    commitment: ClientAcceptanceCommitmentSchema.parse(transaction),
    predecessor: expectedPredecessor,
    registryPredecessor: registryPredecessor(registry),
    registeredAt: transaction.createdAt,
    registrationSequence: registrations.length + 1,
    legacyEvents: null,
  });
  const bytes = canonicalAcceptanceRegistration(registration);
  const root = await ensurePrivateDirectory(acceptanceRegistrationRoot(storeRoot, manifest.projectId));
  const path = join(root, acceptanceRegistrationFilename(transaction.revisionId, transaction.anchorId));
  const store = await trustRoot(projectRoot);
  if (!await writePrivateExclusive(
    path,
    bytes,
    "acceptance-registration-temp-synced",
    store.operations,
  )) {
    const concurrent = await readWithConcurrentCreateRetry(
      path,
      "trusted client acceptance registration",
      MAX_ACCEPTANCE_REGISTRATION_BYTES,
    );
    if (!concurrent.equals(Buffer.from(bytes))) {
      throw new Error("trusted client acceptance registration conflicts with immutable first write");
    }
  }
  await store.operations?.checkpoint?.("acceptance-registration-published");
  const published = await parseAcceptanceRegistrationFile(
    path,
    key,
    manifest.projectId,
    baseRegistration.sha256,
  );
  await commitAcceptanceRegistrationSetAuthority(projectRoot, manifest.projectId, storeRoot, key);
  return published;
}

async function readClientAcceptanceChain(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
  allowOneUnheadedEvent = false,
  allowOneUnpublishedRegistration = false,
  allowLegacyUnregistered = false,
): Promise<ClientAcceptanceChainEntry[]> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw new Error("trusted authorization store is missing");
  const roots = acceptanceRoots(storeRoot, projectId);
  const rootKind = await pathKind(roots.root);
  if (rootKind === "missing") return [];
  if (rootKind !== "directory") throw new Error("trusted client acceptance directory is unsafe");
  await assertExistingPrivateDirectory(roots.root, "trusted client acceptance directory");
  const eventsKind = await pathKind(roots.events);
  const headsKind = await pathKind(roots.heads);
  if (eventsKind !== "directory" || headsKind !== "directory") {
    throw new Error("trusted client acceptance history is missing or unsafe");
  }
  const headNames = await readBoundedPrivateDirectory(
    roots.heads,
    "trusted client acceptance head directory",
    store.operations?.limits?.acceptanceHeads ?? MAX_ACCEPTANCE_EVENTS,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}\.json$/.test(name) ? "include" : "reject",
  );
  headNames.sort();
  const chain: ClientAcceptanceChainEntry[] = [];
  for (const [index, name] of headNames.entries()) {
    const sequence = index + 1;
    if (name !== acceptanceHeadFilename(sequence)) {
      throw new Error("trusted client acceptance head sequence is not contiguous");
    }
    const headBytes = await readPrivateRegularFile(
      join(roots.heads, name),
      "trusted client acceptance head",
      MAX_ACCEPTANCE_HEAD_BYTES,
    );
    let head: ClientAcceptanceHead;
    try {
      head = ClientAcceptanceHeadSchema.parse(JSON.parse(headBytes.toString("utf8")));
      if (canonicalAcceptanceHead(head) !== headBytes.toString("utf8")) throw new Error("head is not canonical");
    } catch (error: unknown) {
      throw new Error("trusted client acceptance head is invalid or tampered", { cause: error });
    }
    assertAcceptanceHeadSignature(key, head);
    const previous = chain.at(-1);
    if (
      head.projectId !== projectId
      || head.sequence !== sequence
      || head.predecessorHeadSha256 !== (previous?.headSha256 ?? null)
    ) throw new Error("trusted client acceptance head chain is invalid or forked");
    const eventPath = join(roots.events, acceptanceEventFilename(sequence, head.eventId));
    const eventBytes = await readPrivateRegularFile(
      eventPath,
      "trusted client acceptance event",
      MAX_ACCEPTANCE_EVENT_BYTES,
    );
    if (sha256(eventBytes) !== head.eventSha256) throw new Error("trusted client acceptance event digest is invalid");
    let event: ClientAcceptanceEvent;
    try {
      event = ClientAcceptanceEventSchema.parse(JSON.parse(eventBytes.toString("utf8")));
      if (canonicalAcceptanceEvent(event) !== eventBytes.toString("utf8")) throw new Error("event is not canonical");
    } catch (error: unknown) {
      throw new Error("trusted client acceptance event is invalid or tampered", { cause: error });
    }
    assertAcceptanceEventSignature(key, event);
    if (
      event.projectId !== projectId
      || event.sequence !== sequence
      || event.eventId !== head.eventId
      || event.state !== head.state
      || event.commitment.transactionId !== head.transactionId
      || JSON.stringify(event.predecessor) !== JSON.stringify(previous
        ? { eventId: previous.event.eventId, eventSha256: previous.eventSha256 }
        : null)
    ) throw new Error("trusted client acceptance event chain is invalid or forked");
    if (sequence === 1 && event.state !== "pending") {
      throw new Error("trusted client acceptance history must begin pending");
    }
    if (previous?.event.state === "pending") {
      if (event.state !== "completed" || !sameCommitment(previous.event.commitment, event.commitment)) {
        throw new Error("trusted client acceptance pending commitment has an invalid successor");
      }
    } else if (previous && event.state !== "pending") {
      throw new Error("trusted client acceptance completed state may advance only to a new pending commitment");
    }
    chain.push({ event, eventSha256: sha256(eventBytes), head, headSha256: sha256(headBytes) });
  }
  const eventNames = await readBoundedPrivateDirectory(
    roots.events,
    "trusted client acceptance event directory",
    store.operations?.limits?.acceptanceEvents ?? MAX_ACCEPTANCE_EVENTS,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}-[0-9a-f-]{36}\.json$/i.test(name) ? "include" : "reject",
  );
  const expectedEvents = chain.map(({ event }) => acceptanceEventFilename(event.sequence, event.eventId)).sort();
  const unexpectedEvents = eventNames.filter((name) => !expectedEvents.includes(name));
  if (
    expectedEvents.some((name) => !eventNames.includes(name))
    || (!allowOneUnheadedEvent && unexpectedEvents.length > 0)
    || unexpectedEvents.length > 1
  ) {
    throw new Error("trusted client acceptance event history is missing, truncated, or forked");
  }
  const registrations = await readAcceptanceRegistrations(projectRoot, projectId, storeRoot, key);
  const represented = new Set<string>();
  for (const [index, entry] of chain.entries()) {
    if (entry.event.schemaVersion === 1) {
      const previous = chain[index - 1];
      const registration = entry.event.state === "pending"
        ? registrations.find(({ registration }) =>
          registration.pendingEventId === entry.event.eventId
          && sameCommitment(registration.commitment, entry.event.commitment)
          && (registration.schemaVersion === 1
            || registration.legacyEvents?.pendingEventSha256 === entry.eventSha256))
        : registrations.find(({ registration }) =>
          previous?.event.schemaVersion === 1
          && previous.event.state === "pending"
          && registration.pendingEventId === previous.event.eventId
          && sameCommitment(registration.commitment, entry.event.commitment)
          && (registration.schemaVersion === 1
            || (registration.legacyEvents?.pendingEventSha256 === previous.eventSha256
              && registration.legacyEvents.completedEventSha256 === entry.eventSha256)));
      if (!registration) {
        if (!allowLegacyUnregistered) {
          throw new Error("legacy trusted client acceptance history requires explicit migration");
        }
        continue;
      }
      represented.add(registration.sha256);
      continue;
    }
    const registrationSha256 = entry.event.acceptanceRegistrationSha256;
    const registration = registrations.find(({ sha256: digest }) =>
      digest === registrationSha256);
    if (
      !registration
      || !sameCommitment(registration.registration.commitment, entry.event.commitment)
      || registration.registration.transactionId !== entry.event.commitment.transactionId
    ) throw new Error("trusted client acceptance event has no exact immutable registration");
    represented.add(registration.sha256);
    if (entry.event.state === "pending") {
      const previous = chain[index - 1];
      const expectedPredecessor = previous ? {
        sequence: previous.head.sequence,
        headSha256: previous.headSha256,
        eventId: previous.event.eventId,
        eventSha256: previous.eventSha256,
        state: previous.event.state,
        revisionId: previous.event.commitment.revisionId,
        anchorId: previous.event.commitment.anchorId,
      } : null;
      if (
        registration.registration.pendingEventId !== entry.event.eventId
        || JSON.stringify(registration.registration.predecessor) !== JSON.stringify(expectedPredecessor)
      ) throw new Error("trusted client acceptance registration predecessor is invalid or forked");
    }
  }
  const unrepresented = registrations.filter(({ sha256: digest }) => !represented.has(digest));
  if (
    unrepresented.length > 1
    || (!allowOneUnpublishedRegistration && unrepresented.length > 0)
  ) throw new Error("trusted client acceptance registration has no exact chain state");
  return chain;
}

async function recoverExactUnheadedAcceptanceEvent(
  projectRoot: string,
  projectId: string,
  storeRoot: string,
  key: Buffer,
  transaction: ClientAcceptanceTransaction,
  state: "pending" | "completed",
  completedAnchorSha256: string | null,
): Promise<ClientAcceptanceChainEntry | null> {
  assertGenerationLeaseHeld(projectRoot);
  const store = await trustRoot(projectRoot);
  const roots = acceptanceRoots(storeRoot, projectId);
  if (await pathKind(roots.root) === "missing") return null;
  const chain = await readClientAcceptanceChain(projectRoot, projectId, storeRoot, key, true, true);
  const expected = new Set(chain.map(({ event }) => acceptanceEventFilename(event.sequence, event.eventId)));
  const names = await readBoundedPrivateDirectory(
    roots.events,
    "trusted client acceptance event directory",
    store.operations?.limits?.acceptanceEvents ?? MAX_ACCEPTANCE_EVENTS,
    (name) => name.startsWith(".") && name.endsWith(".tmp")
      ? "ignore"
      : /^\d{16}-[0-9a-f-]{36}\.json$/i.test(name) ? "include" : "reject",
  );
  const orphanNames = names.filter((name) => !expected.has(name));
  if (orphanNames.length === 0) return null;
  if (orphanNames.length !== 1) throw new Error("trusted client acceptance recovery is ambiguous or forked");
  const bytes = await readPrivateRegularFile(
    join(roots.events, orphanNames[0]!),
    "trusted client acceptance event",
    MAX_ACCEPTANCE_EVENT_BYTES,
  );
  let event: ClientAcceptanceEvent;
  try {
    event = ClientAcceptanceEventSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (canonicalAcceptanceEvent(event) !== bytes.toString("utf8")) throw new Error("event is not canonical");
  } catch (error: unknown) {
    throw new Error("trusted client acceptance orphan event is invalid or tampered", { cause: error });
  }
  assertAcceptanceEventSignature(key, event);
  const previous = chain.at(-1);
  if (
    event.projectId !== projectId
    || event.sequence !== (previous?.head.sequence ?? 0) + 1
    || event.state !== state
    || !sameCommitment(event.commitment, transaction)
    || event.completedAnchorSha256 !== completedAnchorSha256
    || JSON.stringify(event.predecessor) !== JSON.stringify(previous
      ? { eventId: previous.event.eventId, eventSha256: previous.eventSha256 }
      : null)
    || (previous?.event.state === "pending" ? state !== "completed" : state !== "pending")
  ) throw new Error("trusted client acceptance orphan event conflicts with immutable recovery");
  const head = signedAcceptanceHead(key, {
    schemaVersion: 1,
    kind: "client-acceptance-head",
    projectId,
    sequence: event.sequence,
    eventId: event.eventId,
    eventSha256: sha256(bytes),
    state,
    transactionId: transaction.transactionId,
    predecessorHeadSha256: previous?.headSha256 ?? null,
  });
  const headBytes = canonicalAcceptanceHead(head);
  const headPath = join(roots.heads, acceptanceHeadFilename(event.sequence));
  if (!await writePrivateExclusive(headPath, headBytes, "acceptance-head-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(headPath, "trusted client acceptance head", MAX_ACCEPTANCE_HEAD_BYTES);
    if (!existing.equals(Buffer.from(headBytes))) throw new Error("trusted client acceptance recovery head conflicts");
  }
  await store.operations?.checkpoint?.("acceptance-head-published");
  const registry = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
  if (!registry) throw new Error("trusted project registry is missing during client acceptance recovery");
  await synchronizeRegistryHighWater(projectRoot, registry, "clientAcceptance", {
    sequence: head.sequence,
    headSha256: sha256(headBytes),
  });
  const recovered = { event, eventSha256: sha256(bytes), head, headSha256: sha256(headBytes) };
  await commitAcceptanceChainRootAuthority(projectRoot, projectId, storeRoot, key, recovered);
  return recovered;
}

async function readSynchronizedClientAcceptanceChain(
  projectRoot: string,
  projectId: string,
  recoverHighWater = false,
): Promise<ClientAcceptanceChainEntry[]> {
  assertGenerationLeaseHeld(projectRoot);
  const { manifest: project } = await readProjectForTrustedAuthorization(projectRoot);
  if (project.projectId !== projectId) throw new Error("trusted client acceptance belongs to a different project");
  const store = await existingTrustRoot(projectRoot);
  if (!store) {
    if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
    return [];
  }
  const keyKind = await pathKind(join(store.root, KEY_FILE));
  const acceptanceKind = await pathKind(join(store.root, CLIENT_ACCEPTANCE_DIRECTORY, projectId));
  const registrationKind = await pathKind(registrationPath(store.root, projectId));
  const acceptanceRegistrationKind = await pathKind(acceptanceRegistrationRoot(store.root, projectId));
  if (keyKind === "unsafe" || keyKind === "directory") throw new Error("trusted authorization HMAC key is unsafe");
  if (keyKind === "missing") {
    if (
      acceptanceKind !== "missing"
      || registrationKind !== "missing"
      || acceptanceRegistrationKind !== "missing"
    ) {
      throw new Error("trusted authorization HMAC key is missing for observable state");
    }
    if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
    return [];
  }
  const { storeRoot, key } = await readKey(projectRoot);
  if (acceptanceKind === "missing") {
    const registrations = acceptanceRegistrationKind === "missing"
      ? []
      : await readAcceptanceRegistrations(projectRoot, projectId, storeRoot, key);
    if (registrations.length > 0) {
      throw new Error("trusted client acceptance registration has no exact chain state; recovery is required");
    }
    if (
      registrationKind === "missing"
      && await pathKind(registryRoots(storeRoot, projectId).root) === "missing"
    ) {
      if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
      return [];
    }
    const registry = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
    if (registry?.clientAcceptance) {
      throw new Error("trusted client acceptance history is missing below the project registry high-water");
    }
    await assertAcceptanceRootAuthorityReconciled(projectRoot, projectId, storeRoot, key, []);
    return [];
  }
  const chain = await readClientAcceptanceChain(projectRoot, projectId, storeRoot, key);
  const registry = await readProjectRegistry(projectRoot, projectId, storeRoot, key);
  if (!registry) {
    if (chain.length > 0) throw new Error("registered project registry is missing");
    return chain;
  }
  const current = chain.at(-1);
  const actual = current ? { sequence: current.head.sequence, headSha256: current.headSha256 } : null;
  if (!recoverHighWater && registryHighWaterNeedsAdvance(registry.clientAcceptance, "clientAcceptance", actual)) {
    throw new Error("trusted client acceptance recovery is required before project mutations");
  }
  if (recoverHighWater) await synchronizeRegistryHighWater(projectRoot, registry, "clientAcceptance", actual);
  await assertAcceptanceRootAuthorityReconciled(projectRoot, projectId, storeRoot, key, chain);
  return chain;
}

async function migrateLegacyTrustedClientAcceptance(projectRoot: string): Promise<void> {
  await withGenerationLease(projectRoot, async (canonicalRoot) => {
    const project = await readProject(canonicalRoot);
    const store = await existingTrustRoot(canonicalRoot);
    if (!store) {
      if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
      throw new Error("trusted project root authority migration requires a surviving external trust store");
    }
    const keyKind = await pathKind(join(store.root, KEY_FILE));
    if (keyKind !== "file") throw missingTrustRootError();
    const { storeRoot, key } = await readKey(canonicalRoot);
    const baseKind = await pathKind(registrationPath(storeRoot, project.projectId));
    if (baseKind !== "file") {
      throw new Error("trusted project root authority migration requires the surviving signed base registration");
    }
    const base = await parseRegistrationFile(
      registrationPath(storeRoot, project.projectId),
      key,
      project.projectId,
    );
    let root = await readRootAuthority(canonicalRoot, project.projectId, storeRoot, key, {
      allowMissing: true,
      allowRecoveryTail: true,
    });
    const acceptanceKind = await pathKind(join(storeRoot, CLIENT_ACCEPTANCE_DIRECTORY, project.projectId));
    if (acceptanceKind === "unsafe" || acceptanceKind === "file") {
      throw new Error("trusted client acceptance directory is unsafe");
    }
    const chain = acceptanceKind === "directory"
      ? await readClientAcceptanceChain(
        canonicalRoot,
        project.projectId,
        storeRoot,
        key,
        false,
        true,
        true,
      )
      : [];
    if (chain.length === 0 && manifestHasAcceptanceEvidence(project)) {
      throw new Error("local client acceptance evidence has no surviving legacy external history; trust recovery is required");
    }
    if (chain.some(({ event }) => event.schemaVersion !== 1)) {
      throw new Error("missing project root authority for non-legacy acceptance history is a trust-store compromise");
    }
    const existing = await readAcceptanceRegistrations(canonicalRoot, project.projectId, storeRoot, key);
    const planned: Array<AcceptanceRegistrationEntry & { bytes: string; path: string; exists: boolean }> = [];
    let cycleSequence = 0;
    for (const [index, pending] of chain.entries()) {
      if (pending.event.state !== "pending") continue;
      cycleSequence += 1;
      const completed = chain[index + 1]?.event.state === "completed"
        && sameCommitment(chain[index + 1]!.event.commitment, pending.event.commitment)
        ? chain[index + 1]
        : undefined;
      const found = existing.find(({ registration }) =>
        registration.pendingEventId === pending.event.eventId
        && sameCommitment(registration.commitment, pending.event.commitment));
      if (found) {
        if (
          found.registration.schemaVersion === 2
          && (found.registration.registrationSequence !== cycleSequence
            || found.registration.legacyEvents?.pendingEventSha256 !== pending.eventSha256
            || found.registration.legacyEvents.completedEventSha256 !== (completed?.eventSha256 ?? null))
        ) throw new Error("legacy trusted client acceptance migration registration conflicts");
        planned.push({
          ...found,
          bytes: canonicalAcceptanceRegistration(found.registration),
          path: join(
            acceptanceRegistrationRoot(storeRoot, project.projectId),
            acceptanceRegistrationFilename(found.registration.revisionId, found.registration.anchorId),
          ),
          exists: true,
        });
        continue;
      }
      const registration = signedAcceptanceRegistration(key, {
        schemaVersion: 2,
        kind: "client-acceptance-registration",
        projectId: project.projectId,
        projectRegistrationSha256: base.sha256,
        revisionId: pending.event.commitment.revisionId,
        deckRevision: pending.event.commitment.deckRevision,
        anchorId: pending.event.commitment.anchorId,
        transactionId: pending.event.commitment.transactionId,
        pendingEventId: pending.event.eventId,
        commitment: ClientAcceptanceCommitmentSchema.parse(pending.event.commitment),
        predecessor: acceptanceRegistrationPredecessor(chain[index - 1]),
        registryPredecessor: null,
        registeredAt: pending.event.commitment.createdAt,
        registrationSequence: cycleSequence,
        legacyEvents: {
          pendingEventSha256: pending.eventSha256,
          completedEventSha256: completed?.eventSha256 ?? null,
        },
      });
      const bytes = canonicalAcceptanceRegistration(registration);
      planned.push({
        registration,
        sha256: sha256(bytes),
        bytes,
        path: join(
          acceptanceRegistrationRoot(storeRoot, project.projectId),
          acceptanceRegistrationFilename(registration.revisionId, registration.anchorId),
        ),
        exists: false,
      });
    }
    if (existing.some(({ sha256: digest }) => !planned.some(({ sha256: plannedDigest }) => plannedDigest === digest))) {
      throw new Error("legacy trusted client acceptance migration has unrelated or forked registrations");
    }
    if (chain.length > 0 && planned.length === 0) {
      throw new Error("legacy trusted client acceptance migration found no pending cycle roots");
    }
    const plannedAuthority = acceptanceRegistrationSetAuthority(
      planned,
      rootAcceptanceChainHighWater(chain.at(-1)),
    );
    if (root?.authority.clientAcceptance.initialized) {
      const committed = root.authority.clientAcceptance;
      if (
        committed.registrationSequence !== plannedAuthority.registrationSequence
        || committed.registrationSha256 !== plannedAuthority.registrationSha256
        || committed.registrationSetSha256 !== plannedAuthority.registrationSetSha256
      ) throw new Error("trusted project root authority does not match the exact legacy migration set");
    }
    if (!root) {
      root = await initializeRootAuthorityForNewRegistration(
        canonicalRoot,
        project.projectId,
        storeRoot,
        key,
      );
    }
    if (planned.length > 0) {
      await ensurePrivateDirectory(acceptanceRegistrationRoot(storeRoot, project.projectId));
      for (const entry of planned) {
        if (entry.exists) continue;
        if (!await writePrivateExclusive(
          entry.path,
          entry.bytes,
          "acceptance-registration-temp-synced",
          store.operations,
        )) {
          const bytes = await readPrivateRegularFile(
            entry.path,
            "trusted client acceptance registration",
            MAX_ACCEPTANCE_REGISTRATION_BYTES,
          );
          if (!bytes.equals(Buffer.from(entry.bytes))) {
            throw new Error("legacy trusted client acceptance migration registration conflicts");
          }
        }
        await store.operations?.checkpoint?.("acceptance-registration-published");
      }
      root = await commitAcceptanceRegistrationSetAuthority(
        canonicalRoot,
        project.projectId,
        storeRoot,
        key,
      );
    }
    const registry = await readProjectRegistry(
      canonicalRoot,
      project.projectId,
      storeRoot,
      key,
    );
    if (!registry) throw new Error("legacy trusted client acceptance migration requires the surviving project registry");
    const current = chain.at(-1);
    const actual = current ? { sequence: current.head.sequence, headSha256: current.headSha256 } : null;
    let synchronized: ProjectRegistrySnapshot;
    if (!registry.clientAcceptance && actual && actual.sequence > 1) {
      await store.operations?.checkpoint?.("registry-before-acceptance-advance");
      synchronized = await appendProjectRegistryState(canonicalRoot, registry, {
        authorization: registry.authorization,
        calls: registry.calls,
        clientAcceptance: actual,
      });
    } else {
      synchronized = await synchronizeRegistryHighWater(
        canonicalRoot,
        registry,
        "clientAcceptance",
        actual,
      );
    }
    if (current) {
      await commitAcceptanceChainRootAuthority(
        canonicalRoot,
        project.projectId,
        storeRoot,
        key,
        current,
      );
    } else if (!root || synchronized.clientAcceptance) {
      throw new Error("legacy trusted client acceptance migration cannot synthesize an empty acceptance history");
    }
    const migrated = acceptanceKind === "directory"
      ? await readClientAcceptanceChain(canonicalRoot, project.projectId, storeRoot, key)
      : [];
    await assertAcceptanceRootAuthorityReconciled(
      canonicalRoot,
      project.projectId,
      storeRoot,
      key,
      migrated,
    );
  });
}

async function appendClientAcceptanceEvent(
  projectRoot: string,
  transaction: ClientAcceptanceTransaction,
  state: "pending" | "completed",
  completedAnchorSha256: string | null,
): Promise<ClientAcceptanceChainEntry> {
  assertGenerationLeaseHeld(projectRoot);
  const project = await readProject(projectRoot);
  if (project.projectId !== transaction.projectId) throw new Error("trusted client acceptance belongs to a different project");
  const store = await existingTrustRoot(projectRoot);
  if (!store) throw missingTrustRootError();
  const keyKind = await pathKind(join(store.root, KEY_FILE));
  if (keyKind !== "file") throw missingTrustRootError();
  const { storeRoot, key } = await readKey(projectRoot);
  let registry = await ensureProjectRegistryForTransition(
    projectRoot,
    project.projectId,
    storeRoot,
    key,
    true,
  );
  const roots = acceptanceRoots(storeRoot, project.projectId);
  let chain = await readClientAcceptanceChain(
    projectRoot,
    project.projectId,
    storeRoot,
    key,
    true,
    true,
  );
  let current = chain.at(-1);
  let acceptanceRegistration: AcceptanceRegistrationEntry | null = null;
  if (state === "pending") {
    acceptanceRegistration = await ensurePendingAcceptanceRegistration(
      projectRoot,
      project,
      storeRoot,
      key,
      registry,
      current,
      transaction,
    );
  }
  await ensurePrivateDirectory(roots.root);
  await ensurePrivateDirectory(roots.events);
  await ensurePrivateDirectory(roots.heads);
  const recovered = await recoverExactUnheadedAcceptanceEvent(
    projectRoot,
    project.projectId,
    storeRoot,
    key,
    transaction,
    state,
    completedAnchorSha256,
  );
  if (recovered) return recovered;
  chain = await readClientAcceptanceChain(
    projectRoot,
    project.projectId,
    storeRoot,
    key,
    false,
    state === "pending",
  );
  current = chain.at(-1);
  if (current?.event.state === state && sameCommitment(current.event.commitment, transaction)) {
    if (current.event.completedAnchorSha256 !== completedAnchorSha256) {
      throw new Error("trusted client acceptance completion conflicts with immutable first write");
    }
    registry = await readProjectRegistry(projectRoot, project.projectId, storeRoot, key, false, true)
      ?? (() => { throw new Error("trusted project registry is missing after client acceptance publication"); })();
    await synchronizeRegistryHighWater(projectRoot, registry, "clientAcceptance", {
      sequence: current.head.sequence,
      headSha256: current.headSha256,
    });
    await commitAcceptanceChainRootAuthority(
      projectRoot,
      project.projectId,
      storeRoot,
      key,
      current,
    );
    return current;
  }
  if (state === "pending" && current?.event.state === "completed" && sameCommitment(current.event.commitment, transaction)) {
    throw new Error("completed client acceptance cannot receive another pending commitment");
  }
  if (state === "completed") {
    if (!current || current.event.state !== "pending" || !sameCommitment(current.event.commitment, transaction)) {
      throw new Error("trusted client acceptance completion has no exact pending commitment");
    }
    if (current.event.schemaVersion === 2) {
      const registrationSha256 = current.event.acceptanceRegistrationSha256;
      acceptanceRegistration = (await readAcceptanceRegistrations(
        projectRoot,
        project.projectId,
        storeRoot,
        key,
      )).find(({ sha256: digest }) => digest === registrationSha256) ?? null;
      if (!acceptanceRegistration) {
        throw new Error("trusted client acceptance completion has no immutable registration");
      }
    } else {
      acceptanceRegistration = (await readAcceptanceRegistrations(
        projectRoot,
        project.projectId,
        storeRoot,
        key,
      )).find(({ registration }) => registration.schemaVersion === 2
        && registration.legacyEvents?.pendingEventSha256 === current!.eventSha256
        && sameCommitment(registration.commitment, transaction)) ?? null;
      if (!acceptanceRegistration) {
        throw new Error("legacy trusted client acceptance history requires explicit migration");
      }
    }
  } else if (current?.event.state === "pending") {
    throw new Error("trusted client acceptance commitment does not match immutable first write");
  }
  const sequence = (current?.head.sequence ?? 0) + 1;
  const commonEvent = {
    kind: "client-acceptance-event",
    eventId: state === "pending" ? acceptanceRegistration!.registration.pendingEventId : randomUUID(),
    projectId: project.projectId,
    sequence,
    predecessor: current ? { eventId: current.event.eventId, eventSha256: current.eventSha256 } : null,
    state,
    commitment: ClientAcceptanceCommitmentSchema.parse(transaction),
    completedAnchorSha256,
  } as const;
  const event = acceptanceRegistration
    ? signedAcceptanceEvent(key, {
      schemaVersion: 2,
      ...commonEvent,
      acceptanceRegistrationSha256: acceptanceRegistration.sha256,
    })
    : signedAcceptanceEvent(key, { schemaVersion: 1, ...commonEvent });
  const eventBytes = canonicalAcceptanceEvent(event);
  const eventPath = join(roots.events, acceptanceEventFilename(sequence, event.eventId));
  if (!await writePrivateExclusive(eventPath, eventBytes, "acceptance-event-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(eventPath, "trusted client acceptance event", MAX_ACCEPTANCE_EVENT_BYTES);
    if (!existing.equals(Buffer.from(eventBytes))) throw new Error("trusted client acceptance event conflicts");
  }
  await store.operations?.checkpoint?.("acceptance-event-published");
  const head = signedAcceptanceHead(key, {
    schemaVersion: 1,
    kind: "client-acceptance-head",
    projectId: project.projectId,
    sequence,
    eventId: event.eventId,
    eventSha256: sha256(eventBytes),
    state,
    transactionId: transaction.transactionId,
    predecessorHeadSha256: current?.headSha256 ?? null,
  });
  const headBytes = canonicalAcceptanceHead(head);
  const headPath = join(roots.heads, acceptanceHeadFilename(sequence));
  if (!await writePrivateExclusive(headPath, headBytes, "acceptance-head-temp-synced", store.operations)) {
    const existing = await readWithConcurrentCreateRetry(headPath, "trusted client acceptance head", MAX_ACCEPTANCE_HEAD_BYTES);
    if (!existing.equals(Buffer.from(headBytes))) throw new Error("trusted client acceptance head conflicts");
  }
  await store.operations?.checkpoint?.("acceptance-head-published");
  registry = await readProjectRegistry(projectRoot, project.projectId, storeRoot, key, false, true)
    ?? (() => { throw new Error("trusted project registry is missing after client acceptance publication"); })();
  await synchronizeRegistryHighWater(projectRoot, registry, "clientAcceptance", {
    sequence,
    headSha256: sha256(headBytes),
  });
  const published = { event, eventSha256: sha256(eventBytes), head, headSha256: sha256(headBytes) };
  await commitAcceptanceChainRootAuthority(
    projectRoot,
    project.projectId,
    storeRoot,
    key,
    published,
  );
  return published;
}

async function commitTrustedClientAcceptancePending(
  projectRoot: string,
  transaction: ClientAcceptanceTransaction,
): Promise<void> {
  await withGenerationLease(projectRoot, async (canonicalRoot) => {
    await appendClientAcceptanceEvent(canonicalRoot, transaction, "pending", null);
  });
}

async function completeTrustedClientAcceptance(
  projectRoot: string,
  transaction: ClientAcceptanceTransaction,
  completedAnchor: ClientSmokeCopyAnchor,
): Promise<void> {
  await withGenerationLease(projectRoot, async (canonicalRoot) => {
    if (
      completedAnchor.state !== "completed"
      || completedAnchor.anchorId !== transaction.anchorId
      || JSON.stringify(completedAnchor.observation) !== JSON.stringify(transaction.observation)
      || completedAnchor.reopenedCopySha256 !== transaction.reopenedCopySha256
      || JSON.stringify(completedAnchor.acceptanceRecord) !== JSON.stringify(transaction.acceptanceRecord)
      || completedAnchor.completedAt !== transaction.confirmedAt
    ) throw new Error("trusted client acceptance completed anchor does not bind the pending commitment");
    await appendClientAcceptanceEvent(
      canonicalRoot,
      transaction,
      "completed",
      sha256(Buffer.from(JSON.stringify(completedAnchor))),
    );
  });
}

async function assertTrustedClientAcceptanceCommitment(
  projectRoot: string,
  transaction: ClientAcceptanceTransaction,
): Promise<"pending" | "completed"> {
  return withGenerationLease(projectRoot, async (canonicalRoot) => {
    const project = await readProject(canonicalRoot);
    const current = (await readSynchronizedClientAcceptanceChain(canonicalRoot, project.projectId)).at(-1);
    if (!current || !sameCommitment(current.event.commitment, transaction)) {
      throw new Error("trusted client acceptance commitment does not match immutable first write");
    }
    return current.event.state;
  });
}

async function readTrustedClientAcceptanceCommitment(
  projectRoot: string,
): Promise<{ transaction: ClientAcceptanceTransaction; state: "pending" | "completed" } | null> {
  return withGenerationLease(projectRoot, async (canonicalRoot) => {
    const project = await readProject(canonicalRoot);
    const store = await existingTrustRoot(canonicalRoot);
    if (!store) {
      if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
      return null;
    }
    const keyKind = await pathKind(join(store.root, KEY_FILE));
    if (keyKind === "missing") {
      const acceptanceKind = await pathKind(join(store.root, CLIENT_ACCEPTANCE_DIRECTORY, project.projectId));
      const registrationKind = await pathKind(registrationPath(store.root, project.projectId));
      const acceptanceRegistrationKind = await pathKind(acceptanceRegistrationRoot(store.root, project.projectId));
      if (
        acceptanceKind !== "missing"
        || registrationKind !== "missing"
        || acceptanceRegistrationKind !== "missing"
      ) {
        throw new Error("trusted authorization HMAC key is missing for observable state");
      }
      if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
      return null;
    }
    if (keyKind !== "file") throw new Error("trusted authorization HMAC key is unsafe");
    const { storeRoot, key } = await readKey(canonicalRoot);
    const acceptanceKind = await pathKind(join(storeRoot, CLIENT_ACCEPTANCE_DIRECTORY, project.projectId));
    const registrations = await readAcceptanceRegistrations(
      canonicalRoot,
      project.projectId,
      storeRoot,
      key,
    );
    if (acceptanceKind === "missing") {
      if (registrations.length > 0) {
        if (registrations.length !== 1) {
          throw new Error("trusted client acceptance registration recovery is ambiguous or forked");
        }
        const registry = await readProjectRegistry(canonicalRoot, project.projectId, storeRoot, key, false, true);
        if (
          !registry
          || JSON.stringify(registryPredecessor(registry))
            !== JSON.stringify(registrations[0]!.registration.registryPredecessor)
        ) throw new Error("trusted client acceptance registration exposes deleted or truncated chain state");
        return {
          transaction: ClientAcceptanceCommitmentSchema.parse(registrations[0]!.registration.commitment),
          state: "pending",
        };
      }
      if (
        await pathKind(registrationPath(storeRoot, project.projectId)) === "missing"
        && await pathKind(registryRoots(storeRoot, project.projectId).root) === "missing"
      ) {
        if (manifestHasAcceptanceEvidence(project)) throw missingTrustRootError();
        return null;
      }
      const registry = await readProjectRegistry(canonicalRoot, project.projectId, storeRoot, key, false, true);
      if (registry?.clientAcceptance) {
        throw new Error("trusted client acceptance history is missing below the project registry high-water");
      }
      await assertAcceptanceRootAuthorityReconciled(canonicalRoot, project.projectId, storeRoot, key, []);
      return null;
    }
    const roots = acceptanceRoots(storeRoot, project.projectId);
    const chain = await readClientAcceptanceChain(canonicalRoot, project.projectId, storeRoot, key, true, true);
    const expected = new Set(chain.map(({ event }) => acceptanceEventFilename(event.sequence, event.eventId)));
    const eventNames = await readBoundedPrivateDirectory(
      roots.events,
      "trusted client acceptance event directory",
      store.operations?.limits?.acceptanceEvents ?? MAX_ACCEPTANCE_EVENTS,
      (name) => name.startsWith(".") && name.endsWith(".tmp")
        ? "ignore"
        : /^\d{16}-[0-9a-f-]{36}\.json$/i.test(name) ? "include" : "reject",
    );
    const orphanNames = eventNames.filter((name) => !expected.has(name));
    if (orphanNames.length > 1) throw new Error("trusted client acceptance recovery is ambiguous or forked");
    if (orphanNames.length === 1) {
      const bytes = await readPrivateRegularFile(
        join(roots.events, orphanNames[0]!),
        "trusted client acceptance event",
        MAX_ACCEPTANCE_EVENT_BYTES,
      );
      let event: ClientAcceptanceEvent;
      try {
        event = ClientAcceptanceEventSchema.parse(JSON.parse(bytes.toString("utf8")));
        if (canonicalAcceptanceEvent(event) !== bytes.toString("utf8")) throw new Error("event is not canonical");
      } catch (error: unknown) {
        throw new Error("trusted client acceptance orphan event is invalid or tampered", { cause: error });
      }
      assertAcceptanceEventSignature(key, event);
      if (event.schemaVersion === 2) {
        const registration = registrations.find(({ sha256: digest }) =>
          digest === event.acceptanceRegistrationSha256);
        if (
          !registration
          || registration.registration.pendingEventId !== (event.state === "pending"
            ? event.eventId
            : registration.registration.pendingEventId)
          || !sameCommitment(registration.registration.commitment, event.commitment)
        ) throw new Error("trusted client acceptance orphan event has no exact immutable registration");
      }
      const previous = chain.at(-1);
      if (
        event.projectId !== project.projectId
        || event.sequence !== (previous?.head.sequence ?? 0) + 1
        || JSON.stringify(event.predecessor) !== JSON.stringify(previous
          ? { eventId: previous.event.eventId, eventSha256: previous.eventSha256 }
          : null)
        || (previous?.event.state === "pending" ? event.state !== "completed" : event.state !== "pending")
      ) throw new Error("trusted client acceptance orphan event conflicts with immutable history");
      const registry = await readProjectRegistry(canonicalRoot, project.projectId, storeRoot, key, false, true);
      const expectedHighWater = registry?.clientAcceptance;
      if (expectedHighWater && expectedHighWater.sequence >= event.sequence) {
        throw new Error("trusted client acceptance head history is missing or truncated below the project registry high-water");
      }
      return {
        transaction: ClientAcceptanceCommitmentSchema.parse(event.commitment),
        state: event.state,
      };
    }
    const representedRegistrationDigests = new Set<string>();
    for (const [index, entry] of chain.entries()) {
      if (entry.event.schemaVersion === 2) {
        representedRegistrationDigests.add(entry.event.acceptanceRegistrationSha256);
        continue;
      }
      const previous = chain[index - 1];
      const registration = entry.event.state === "pending"
        ? registrations.find(({ registration }) =>
          registration.pendingEventId === entry.event.eventId
          && sameCommitment(registration.commitment, entry.event.commitment))
        : registrations.find(({ registration }) =>
          previous?.event.schemaVersion === 1
          && previous.event.state === "pending"
          && registration.pendingEventId === previous.event.eventId
          && sameCommitment(registration.commitment, entry.event.commitment));
      if (registration) representedRegistrationDigests.add(registration.sha256);
    }
    const unrepresentedRegistrations = registrations.filter(({ sha256: digest }) =>
      !representedRegistrationDigests.has(digest));
    if (unrepresentedRegistrations.length > 0) {
      if (unrepresentedRegistrations.length !== 1) {
        throw new Error("trusted client acceptance registration recovery is ambiguous or forked");
      }
      const registry = await readProjectRegistry(canonicalRoot, project.projectId, storeRoot, key, false, true);
      if (
        !registry
        || JSON.stringify(registryPredecessor(registry))
          !== JSON.stringify(unrepresentedRegistrations[0]!.registration.registryPredecessor)
      ) throw new Error("trusted client acceptance registration exposes deleted or truncated chain state");
      return {
        transaction: ClientAcceptanceCommitmentSchema.parse(unrepresentedRegistrations[0]!.registration.commitment),
        state: "pending",
      };
    }
    const registry = await readProjectRegistry(canonicalRoot, project.projectId, storeRoot, key, false, true);
    if (!registry) throw new Error("registered project registry is missing for trusted client acceptance");
    const current = chain.at(-1);
    const actual = current ? { sequence: current.head.sequence, headSha256: current.headSha256 } : null;
    registryHighWaterNeedsAdvance(registry.clientAcceptance, "clientAcceptance", actual);
    return current ? {
      transaction: ClientAcceptanceCommitmentSchema.parse(current.event.commitment),
      state: current.event.state,
    } : null;
  });
}

async function assertNoPendingTrustedClientAcceptance(projectRoot: string): Promise<void> {
  await withGenerationLease(projectRoot, async (canonicalRoot) => {
    const project = await readProject(canonicalRoot);
    await assertNoPendingTrustedClientAcceptanceForProjectUnderLease(canonicalRoot, project.projectId);
  });
}

async function assertNoPendingTrustedClientAcceptanceForProjectUnderLease(
  projectRoot: string,
  projectId: string,
  allowCompletedRevisionTransition = false,
): Promise<void> {
  assertGenerationLeaseHeld(projectRoot);
  const validProjectId = z.string().uuid().parse(projectId);
  const current = (await readSynchronizedClientAcceptanceChain(projectRoot, validProjectId, false)).at(-1);
  if (current?.event.state === "pending") {
    throw new Error("project mutations are frozen while trusted client acceptance is pending");
  }
  if (current?.event.state === "completed") {
    const { manifest } = await readProjectForTrustedAuthorization(projectRoot);
    if (manifest.projectId !== validProjectId) {
      throw new Error("trusted client acceptance belongs to a different project");
    }
    await assertCompletedAcceptanceManifest(projectRoot, manifest, current);
    if (
      manifest.currentRevision.id === current.event.commitment.revisionId
      && !allowCompletedRevisionTransition
    ) {
      throw new Error(
        "project mutations are frozen after completed client acceptance; begin an explicit controlled revision transition",
      );
    }
  }
}

async function assertNoPendingTrustedClientAcceptanceForProject(
  projectRoot: string,
  projectId: string,
): Promise<void> {
  await withGenerationLease(projectRoot, async (canonicalRoot) => {
    await assertNoPendingTrustedClientAcceptanceForProjectUnderLease(
      canonicalRoot,
      projectId,
    );
  });
}

async function assertTrustedClientAcceptanceAllowsRevisionTransition(
  projectRoot: string,
  projectId: string,
): Promise<void> {
  await withGenerationLease(projectRoot, async (canonicalRoot) => {
    await assertNoPendingTrustedClientAcceptanceForProjectUnderLease(
      canonicalRoot,
      projectId,
      true,
    );
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
  await assertNoPendingTrustedClientAcceptanceForProjectUnderLease(projectRoot, project.projectId);
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
