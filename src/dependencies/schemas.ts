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

export const AiImageCapabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  skill: z.literal("ai-image-to-ppt"),
  contracts: AiImageSkillContractsSchema,
  routingOrder: z.tuple([
    HostRouteSchema.extend({ provider: z.literal("openai") }),
    ApiRouteSchema.extend({ provider: z.literal("openai"), defaultModel: z.literal("gpt-image-2") }),
    HostRouteSchema.extend({ provider: z.literal("gemini") }),
    ApiRouteSchema.extend({ provider: z.literal("gemini") }),
    HostRouteSchema.extend({ provider: z.literal("doubao") }),
    ApiRouteSchema.extend({ provider: z.literal("doubao") }),
  ]),
  outputs: z.object({
    normalizedSlide: z.object({ format: z.literal("image"), width: z.literal(1920), height: z.literal(1080) }).strict(),
    editableInput: z.object({ format: z.literal("png"), width: z.literal(1280), height: z.literal(720) }).strict(),
  }).strict(),
  scripts: AiImageSkillScriptsSchema,
}).strict();

export const EditableObjectNamesSchema = z.object({
  background: z.literal("asset-background"),
  text: z.literal("text-<id>"),
  shape: z.literal("shape-<id>-<label>"),
  asset: z.literal("asset-<id>"),
}).strict();

export const DependencyContractSchema = z.object({
  contractVersion: z.literal(2),
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
      }).strict(),
    }).strict(),
    z.object({
      skill: z.literal("image-to-editable-pptx"),
      cliFlag: z.literal("--editable-skill"),
      resolution: z.literal("explicit-only"),
      required: z.tuple([z.literal("package.json"), z.literal("skills/image-to-editable-pptx/SKILL.md")]),
      capabilities: z.object({
        version: z.literal(">=0.2.0 <0.3.0"),
        manifestVersion: z.literal(2),
        officialDonor: z.literal("slide-editable.pptx"),
        objectNames: EditableObjectNamesSchema,
      }).strict(),
    }).strict(),
  ]),
}).strict();

export const AiImageSkillDependencySchema = z.object({
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

export const ImageToEditablePptxSkillDependencySchema = z.object({
  kind: z.literal("image-to-editable-pptx"),
  root: z.string().min(1),
  packageFile: z.string().min(1),
  packageSha256: Sha256Schema,
  skillFile: z.string().min(1),
  skillSha256: Sha256Schema,
  version: z.string().min(1),
  manifestVersion: z.literal(2),
  officialDonor: z.literal("slide-editable.pptx"),
  objectNames: EditableObjectNamesSchema,
}).strict();

export type AiImageSkillDependency = z.infer<typeof AiImageSkillDependencySchema>;
export type ImageToEditablePptxSkillDependency = z.infer<typeof ImageToEditablePptxSkillDependencySchema>;

export type ResolvedDependencies = {
  contractFile: string;
  contractSha256: string;
  ai: AiImageSkillDependency;
  editable: ImageToEditablePptxSkillDependency;
  integrity: {
    aiSkillSha256: string;
    aiCapabilityManifestSha256: string;
    aiScripts: Record<keyof AiImageSkillDependency["scripts"], string>;
    editablePackageSha256: string;
    editableSkillSha256: string;
    contractSha256: string;
  };
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
    skillSha256: string;
    version: string | null;
    manifestVersion: 2;
    officialDonor: "slide-editable.pptx";
    objectNames: z.infer<typeof ImageToEditablePptxSkillDependencySchema>["objectNames"];
  };
  errors: Array<{ dependency: string; code: string; safeMessage: string }>;
};
