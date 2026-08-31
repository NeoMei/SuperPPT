import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

export const HostRuntimeCapabilitiesSchema = z.object({
  source: z.literal("agent-host"),
  localFilesystem: z.boolean(),
  localFileLinks: z.boolean(),
}).strict();

export type HostRuntimeCapabilities = z.infer<typeof HostRuntimeCapabilitiesSchema>;

export function requireLocalDeckHandoff(capabilities: unknown): asserts capabilities is HostRuntimeCapabilities {
  let valid: HostRuntimeCapabilities;
  try {
    valid = HostRuntimeCapabilitiesSchema.parse(capabilities);
  } catch (error: unknown) {
    throw new Error("local deck handoff requires injected agent-host capabilities", { cause: error });
  }
  if (!valid.localFilesystem) throw new Error("local deck handoff requires injected local filesystem access");
  if (!valid.localFileLinks) throw new Error("local deck handoff requires injected local file links support");
}

export function readInjectedHostRuntimeCapabilities(environment: NodeJS.ProcessEnv): HostRuntimeCapabilities {
  const serialized = environment.SUPERPPT_HOST_CAPABILITIES;
  if (!serialized) throw new Error("local deck handoff requires injected host capabilities");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error: unknown) {
    throw new Error("injected host capabilities are not valid JSON", { cause: error });
  }
  requireLocalDeckHandoff(parsed);
  return parsed;
}

function escapeMarkdownLabel(label: string): string {
  if (label.length === 0 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("local PPTX link label contains unsafe control characters");
  }
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function formatLocalPptxLink(absolutePath: string, label: string): string {
  if (!isAbsolute(absolutePath)) throw new Error("local PPTX link target must be absolute");
  if (normalize(absolutePath) !== absolutePath) throw new Error("local PPTX link target must be canonical");
  if (!absolutePath.toLowerCase().endsWith(".pptx")) throw new Error("local deck link target must be a PPTX");
  if (/[\u0000-\u001f\u007f<>]/u.test(absolutePath)) {
    throw new Error("local PPTX link target contains unsafe control or angle-bracket characters");
  }
  return `[${escapeMarkdownLabel(label)}](<${absolutePath}>)`;
}
