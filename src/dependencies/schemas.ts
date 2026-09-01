import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AiImageSkillContractsSchema = z.object({
  generationResult: z.literal(1),
  serialStickyRouterReport: z.literal(1),
  hostImageImport: z.literal(1),
  editableInput: z.literal(1),
}).strict();

export const AiImageSkillScriptsSchema = z.object({
  generationResult: z.string().min(1),
  hostRoutingPolicy: z.string().min(1),
  importHostImage: z.string().min(1),
  prepareEditableInput: z.string().min(1),
  apiGenerator: z.string().min(1),
  normalizedExport: z.string().min(1),
}).strict();

export const AiImageSkillScriptHashesSchema = z.object({
  generationResult: Sha256Schema,
  hostRoutingPolicy: Sha256Schema,
  importHostImage: Sha256Schema,
  prepareEditableInput: Sha256Schema,
  apiGenerator: Sha256Schema,
  normalizedExport: Sha256Schema,
}).strict();

const HostRouteSchema = z.object({
  provider: z.enum(["openai", "gemini", "doubao"]),
  channel: z.literal("host"),
  modelSelection: z.literal("host-owned"),
}).strict();

const ApiRouteSchema = z.object({
  provider: z.enum(["openai", "gemini", "doubao"]),
  channel: z.literal("api"),
  defaultModel: z.string().min(1),
}).strict();

export const AiImageRoutingOrderSchema = z.tuple([
  HostRouteSchema.extend({ provider: z.literal("openai") }),
  ApiRouteSchema.extend({ provider: z.literal("openai"), defaultModel: z.literal("gpt-image-2") }),
  HostRouteSchema.extend({ provider: z.literal("gemini") }),
  ApiRouteSchema.extend({ provider: z.literal("gemini"), defaultModel: z.literal("gemini-3.1-flash-image") }),
  HostRouteSchema.extend({ provider: z.literal("doubao") }),
  ApiRouteSchema.extend({ provider: z.literal("doubao"), defaultModel: z.literal("doubao-seedream-5-0-260128") }),
]);

export const AiImageOutputsSchema = z.object({
  normalizedSlide: z.object({ format: z.literal("image"), width: z.literal(1920), height: z.literal(1080) }).strict(),
  editableInput: z.object({ format: z.literal("png"), width: z.literal(1280), height: z.literal(720) }).strict(),
}).strict();

export const AiImageCapabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  skill: z.literal("ai-image-to-ppt"),
  contracts: AiImageSkillContractsSchema,
  routingOrder: AiImageRoutingOrderSchema,
  outputs: AiImageOutputsSchema,
  scripts: AiImageSkillScriptsSchema,
}).strict();

export const EditableObjectNamesSchema = z.object({
  background: z.literal("asset-background"),
  text: z.literal("text-<id>"),
  shape: z.literal("shape-<id>-<label>"),
  asset: z.literal("asset-<id>"),
}).strict();

export const EditableInvocationSchema = z.object({
  command: z.literal("npm"),
  script: z.literal("cli"),
  separator: z.literal("--"),
  subcommand: z.literal("run"),
  inputFlag: z.literal("--image"),
  outputFlag: z.literal("--out"),
}).strict();

export const EditableOutputContractSchema = z.object({
  ownershipMarker: z.object({
    path: z.literal(".image-to-editable-pptx-output.json"),
    markerVersion: z.literal(1),
    appId: z.literal("image-to-editable-pptx"),
    artifactKind: z.literal("published-output"),
  }).strict(),
  manifest: z.object({ path: z.literal("manifest.json"), version: z.literal(2) }).strict(),
  ledger: z.object({ path: z.literal("run-ledger.json"), version: z.literal(2) }).strict(),
  officialDonor: z.literal("slide-editable.pptx"),
  objectNames: EditableObjectNamesSchema,
}).strict();

export const EditableConsumerProfileSchema = z.object({
  package: z.object({
    name: z.literal("image-to-editable-pptx"),
    version: z.literal(">=0.2.0 <0.3.0"),
    stable: z.literal(true),
    nodeEngine: z.literal(">=22.6"),
    cliScript: z.literal("tsx src/cli.ts"),
  }).strict(),
  plugin: z.object({
    name: z.literal("image-to-editable-pptx"),
    versionMatchesPackage: z.literal(true),
    skills: z.literal("./skills/"),
  }).strict(),
  invocation: EditableInvocationSchema,
  outputContract: EditableOutputContractSchema,
}).strict();

export const DependencyContractSchema = z.object({
  contractVersion: z.literal(3),
  dependencies: z.tuple([
    z.object({
      skill: z.literal("ai-image-to-ppt"),
      cliFlag: z.literal("--ai-skill"),
      resolution: z.literal("explicit-only"),
      required: z.tuple([z.literal("SKILL.md"), z.literal("references/capabilities.json")]),
      capabilityManifest: z.object({
        path: z.literal("references/capabilities.json"),
        schemaVersion: z.literal(1),
        contracts: AiImageSkillContractsSchema,
        scripts: AiImageSkillScriptsSchema,
        routingOrder: AiImageRoutingOrderSchema,
        outputs: AiImageOutputsSchema,
      }).strict(),
    }).strict(),
    z.object({
      skill: z.literal("image-to-editable-pptx"),
      cliFlag: z.literal("--editable-skill"),
      resolution: z.literal("explicit-only"),
      required: z.tuple([
        z.literal("package.json"),
        z.literal(".codex-plugin/plugin.json"),
        z.literal("skills/image-to-editable-pptx/SKILL.md"),
        z.literal("src/cli.ts"),
      ]),
      consumerProfile: EditableConsumerProfileSchema,
    }).strict(),
  ]),
}).strict();

export const EditableSourceTreeIdentitySchema = z.object({
  root: z.string().min(1),
  sha256: Sha256Schema,
  fileCount: z.number().int().min(1).max(2048),
  totalBytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
}).strict();

export const ImageToEditablePptxSkillDependencySchema = z.object({
  kind: z.literal("image-to-editable-pptx"),
  root: z.string().min(1),
  packageFile: z.string().min(1),
  packageSha256: Sha256Schema,
  pluginFile: z.string().min(1),
  pluginSha256: Sha256Schema,
  skillFile: z.string().min(1),
  skillSha256: Sha256Schema,
  cliFile: z.string().min(1),
  cliSha256: Sha256Schema,
  sourceTree: EditableSourceTreeIdentitySchema,
  version: z.string().min(1),
  packageName: z.literal("image-to-editable-pptx"),
  nodeEngine: z.literal(">=22.6"),
  cliScript: z.literal("tsx src/cli.ts"),
  pluginName: z.literal("image-to-editable-pptx"),
  pluginSkills: z.literal("./skills/"),
  invocation: EditableInvocationSchema,
  outputContract: EditableOutputContractSchema,
}).strict();

export const AiImageSkillDependencyIdentitySchema = z.object({
  kind: z.literal("ai-image-to-ppt"),
  root: z.string().min(1),
  skillFile: z.string().min(1),
  skillSha256: Sha256Schema,
  gitRevision: z.string().min(1).nullable(),
  capabilityManifestFile: z.string().min(1),
  capabilityManifestSha256: Sha256Schema,
  capabilitySchemaVersion: z.literal(1),
  contracts: AiImageSkillContractsSchema,
  routingOrder: AiImageCapabilityManifestSchema.shape.routingOrder,
  outputs: AiImageCapabilityManifestSchema.shape.outputs,
  scripts: AiImageSkillScriptsSchema,
  scriptSha256: AiImageSkillScriptHashesSchema,
}).strict();

export const WorkflowPreflightBindingSchema = z.object({
  bindingVersion: z.literal(2),
  contractFile: z.string().min(1),
  contractSha256: Sha256Schema,
  ai: AiImageSkillDependencyIdentitySchema,
  editable: ImageToEditablePptxSkillDependencySchema,
  host: z.object({
    source: z.literal("agent-host"),
    localFilesystem: z.literal(true),
    localFileLinks: z.literal(true),
  }).strict(),
  attestationSha256: Sha256Schema,
}).strict();

export const AiImageSkillDependencySchema = AiImageSkillDependencyIdentitySchema.extend({
  workflowPreflight: WorkflowPreflightBindingSchema.nullable(),
}).strict();

export type AiImageSkillDependency = z.infer<typeof AiImageSkillDependencySchema>;
export type ImageToEditablePptxSkillDependency = z.infer<typeof ImageToEditablePptxSkillDependencySchema>;
export type WorkflowPreflightBinding = z.infer<typeof WorkflowPreflightBindingSchema>;
export type EditableInvocation = z.infer<typeof EditableInvocationSchema>;
export type EditableOutputContract = z.infer<typeof EditableOutputContractSchema>;

export type ResolvedDependencies = {
  contractFile: string;
  contractSha256: string;
  ai: AiImageSkillDependency;
  editable: ImageToEditablePptxSkillDependency;
};

export type DependencyPreflight = {
  ok: boolean;
  aiImageToPpt: {
    root: string;
    skillSha256: string;
    gitRevision: string | null;
    capabilityManifestSha256: string;
    capabilitySchemaVersion: 1;
    contracts: z.infer<typeof AiImageSkillContractsSchema>;
    routingOrder: z.infer<typeof AiImageCapabilityManifestSchema>["routingOrder"];
    outputs: z.infer<typeof AiImageCapabilityManifestSchema>["outputs"];
    requiredScripts: Record<string, { path: string; sha256: string }>;
  };
  imageToEditablePptx: {
    root: string;
    version: string;
    packageSha256: string;
    pluginSha256: string;
    skillSha256: string;
    cliSha256: string;
    sourceTreeSha256: string;
    manifestVersion: 2;
    ledgerVersion: 2;
    officialDonor: "slide-editable.pptx";
    objectNames: z.infer<typeof EditableObjectNamesSchema>;
    invocation: z.infer<typeof EditableInvocationSchema>;
  };
  errors: Array<{ dependency: string; code: string; safeMessage: string }>;
};
