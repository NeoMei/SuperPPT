import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AiImageSkillScriptsSchema = z.object({
  generationResult: z.string().min(1),
  hostRoutingPolicy: z.string().min(1),
  importHostImage: z.string().min(1),
  prepareEditableInput: z.string().min(1),
}).strict();

export const AiImageSkillScriptHashesSchema = z.object({
  generationResult: Sha256Schema,
  hostRoutingPolicy: Sha256Schema,
  importHostImage: Sha256Schema,
  prepareEditableInput: Sha256Schema,
}).strict();

export const AiImageSkillDependencySchema = z.object({
  kind: z.literal("ai-image-to-ppt"),
  root: z.string().min(1),
  skillFile: z.string().min(1),
  skillSha256: Sha256Schema,
  gitRevision: z.string().min(1).nullable(),
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
  version: z.string().min(1).nullable(),
}).strict();

export type AiImageSkillDependency = z.infer<typeof AiImageSkillDependencySchema>;
export type ImageToEditablePptxSkillDependency = z.infer<typeof ImageToEditablePptxSkillDependencySchema>;

export type ResolvedDependencies = {
  ai: AiImageSkillDependency;
  editable: ImageToEditablePptxSkillDependency;
  integrity: {
    aiSkillSha256: string;
    aiScripts: Record<keyof AiImageSkillDependency["scripts"], string>;
    editablePackageSha256: string;
    editableSkillSha256: string;
  };
};

export type DependencyPreflight = {
  ok: boolean;
  aiImageToPpt: {
    root: string;
    skillSha256: string;
    gitRevision: string | null;
    requiredScripts: Record<string, { path: string; sha256: string }>;
  };
  imageToEditablePptx: {
    root: string;
    skillSha256: string;
    version: string | null;
  };
  errors: Array<{ dependency: string; code: string; safeMessage: string }>;
};
