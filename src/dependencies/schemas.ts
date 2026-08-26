import { z } from "zod";

export const ProviderSchema = z.object({
  id: z.string().min(1),
  module: z.string().regex(/^scripts\/[a-z0-9_-]+\.py$/),
  callable: z.literal("gen"),
  outputFormats: z.array(z.enum(["png", "jpg", "jpeg"])).min(1),
  supportsReferenceImages: z.boolean(),
}).strict();

export const AiCapabilitiesSchema = z.object({
  contractVersion: z.literal(1),
  defaultProvider: z.string().min(1),
  providers: z.array(ProviderSchema).min(1),
  reviewer: z.object({
    module: z.string().regex(/^scripts\/[a-z0-9_-]+\.py$/),
    callable: z.literal("check"),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (!value.providers.some((provider) => provider.id === value.defaultProvider)) {
    context.addIssue({
      code: "custom",
      message: "defaultProvider must name a declared provider",
      path: ["defaultProvider"],
    });
  }
});

export type ProviderCapability = z.infer<typeof ProviderSchema>;
export type AiCapabilities = z.infer<typeof AiCapabilitiesSchema>;

export type ResolvedDependencies = {
  ai: AiCapabilities & { root: string; source: "manifest" | "legacy" };
  editable: {
    root: string;
    version: string;
    cli: { cwd: string; command: "npm"; args: ["run", "cli", "--"] };
  };
};

export type PreflightReport = {
  ok: boolean;
  aiRoot: string;
  editableRoot: string;
  providers: string[];
  reviewerAvailable: boolean;
  problems: string[];
};
