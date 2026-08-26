import { closeSync } from "node:fs";
import { basename, dirname } from "node:path";

import { openGenerationDirectory } from "./anchored-dir.js";
import { runBridge } from "./bridge-process.js";
import { withPrivateInput } from "./private-input.js";
import { QualityDecisionSchema, type QualityDecision } from "./schemas.js";

export async function reviewSlide(options: {
  runner: string;
  modulePath: string;
  callable?: string;
  image: string;
  requiredText: string[];
  styleName: string;
  timeoutMs?: number;
  beforeExecute?: (privatePath: string) => Promise<void>;
  afterImageDirectoryOpened?: () => Promise<void>;
  afterReviewerModuleOpened?: () => Promise<void>;
}): Promise<QualityDecision> {
  const question = [
    "Return JSON only with exactly these keys: ok, issues, requiredText, styleConsistent, hierarchyClear, richDetail, noForbiddenContent.",
    `requiredText must contain one {text,present,exact} result for each required copy item: ${JSON.stringify(options.requiredText)}.`,
    `Expected style: ${options.styleName}.`,
    "Mark ok true only when issues is empty, every required item is present and exact, and every boolean check is true.",
  ].join("\n");
  const directory = openGenerationDirectory(dirname(options.image));
  let imageFd: number | undefined;
  try {
    await options.afterImageDirectoryOpened?.();
    directory.assertCurrent();
    imageFd = directory.openRegular(basename(options.image));
    const activeImageFd = imageFd;
    return await withPrivateInput({
      target: options.image,
      parent: directory,
      suffix: "review.json",
      value: JSON.stringify({ question }),
      beforeExecute: options.beforeExecute,
      action: async (input) => {
        let stdout: string;
        try {
          stdout = await runBridge({
            runner: options.runner,
            mode: "review",
            modulePath: options.modulePath,
            callable: options.callable ?? "check",
            inputFd: input.fd,
            targetFd: activeImageFd,
            targetPath: options.image,
            timeoutMs: options.timeoutMs ?? 120_000,
            afterModuleOpened: options.afterReviewerModuleOpened,
          });
        } catch {
          throw new Error("reviewer execution failed");
        }
        try {
          return QualityDecisionSchema.parse(JSON.parse(stdout));
        } catch {
          throw new Error("reviewer returned invalid quality JSON");
        }
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && ["reviewer execution failed", "reviewer returned invalid quality JSON"].includes(error.message)) {
      throw error;
    }
    throw new Error("reviewer execution failed");
  } finally {
    if (imageFd !== undefined) closeSync(imageFd);
    directory.close();
  }
}

export function correctivePrompt(original: string, quality: QualityDecision): string {
  const decision = QualityDecisionSchema.parse(quality);
  return [
    original,
    "CORRECTION REQUIRED:",
    ...decision.issues.map((issue) => `- ${issue}`),
    "Preserve approved content and style; change only the listed failures.",
    "Final self-check must pass all prior constraints.",
  ].join("\n\n");
}
