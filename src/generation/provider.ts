import { createHash } from "node:crypto";
import { closeSync, constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import { openGenerationDirectory } from "./anchored-dir.js";
import { cleanupAbandonedProviderFiles, ownedTemporaryName } from "./abandoned.js";
import { AttemptLedgerSchema, type AttemptLedger } from "./schemas.js";
import { runBridge } from "./bridge-process.js";
import { withPrivateInput } from "./private-input.js";

const MAX_PROVIDER_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDER_PIXELS = 64 * 1024 * 1024;
const MAX_PROVIDER_DIMENSION = 8192;
const ALLOWED_FORMATS = new Set(["png", "jpeg"]);

const hash = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

async function validateProviderImage(bytes: Buffer, allowedFormats?: readonly string[]): Promise<void> {
  try {
    if (bytes.length <= 0 || bytes.length > MAX_PROVIDER_BYTES) throw new Error("invalid provider file");
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PROVIDER_PIXELS, animated: false });
    const metadata = await decoder.metadata();
    const accepted = allowedFormats?.map((format) => format === "jpg" ? "jpeg" : format) ?? [...ALLOWED_FORMATS];
    if (
      !metadata.format
      || !ALLOWED_FORMATS.has(metadata.format)
      || !accepted.includes(metadata.format)
      || !metadata.width
      || !metadata.height
      || metadata.width > MAX_PROVIDER_DIMENSION
      || metadata.height > MAX_PROVIDER_DIMENSION
      || (metadata.pages ?? 1) !== 1
    ) throw new Error("invalid provider metadata");
    // Full decode happens here, before any destination is touched.
    await decoder.clone().raw().toBuffer();
  } catch {
    throw new Error("provider output is not an allowed complete image");
  }
}

async function normalize(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "error", limitInputPixels: MAX_PROVIDER_PIXELS })
    .resize(1920, 1080, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

export type GenerateSlideOptions = {
  runner: string;
  modulePath: string;
  callable: string;
  providerId?: string;
  slideId?: string;
  revisionId?: string;
  prompt: string;
  output: string;
  attempt: number;
  allowedFormats?: readonly ("png" | "jpg" | "jpeg")[];
  trustedRoot?: string;
  timeoutMs?: number;
  beforeExecute?: (privatePath: string) => Promise<void>;
  afterOutputDirectoryOpened?: () => Promise<void>;
  afterProviderModuleOpened?: () => Promise<void>;
};

export async function generateSlide(options: GenerateSlideOptions): Promise<AttemptLedger> {
  if (!isAbsolute(options.output)) throw new Error("provider output must be absolute");
  if (!options.prompt) throw new Error("provider prompt must not be empty");
  const output = resolve(options.output);
  const outputParent = await realpath(dirname(output));
  const trustedRoot = await realpath(options.trustedRoot ?? outputParent);
  const difference = relative(trustedRoot, outputParent);
  if (difference.startsWith("..") || isAbsolute(difference) || difference.split(sep).includes("..")) {
    throw new Error("provider output is outside the trusted root");
  }
  const outputName = output.slice(outputParent.length + 1);
  if (!outputName || outputName.includes("/") || outputName.includes("\\")) throw new Error("provider output path is invalid");
  const directory = openGenerationDirectory(outputParent);
  const rawName = `.${ownedTemporaryName("provider-image")}`;
  const started = performance.now();
  let providerSucceeded = false;
  let rawFd: number | undefined;
  try {
    await options.afterOutputDirectoryOpened?.();
    directory.assertCurrent();
    cleanupAbandonedProviderFiles(directory);
    directory.writeExclusive(rawName, Buffer.alloc(0));
    rawFd = directory.openRegular(rawName, constants.O_RDWR);
    const activeRawFd = rawFd;
    await withPrivateInput({
      target: output,
      parent: directory,
      suffix: "prompt.txt",
      value: options.prompt,
      beforeExecute: options.beforeExecute,
      action: async (input) => {
        try {
          directory.assertCurrent();
          await runBridge({
            runner: options.runner,
            mode: "generate",
            modulePath: options.modulePath,
            callable: options.callable,
            inputFd: input.fd,
            inputValue: input.value,
            targetFd: activeRawFd,
            targetPath: `${outputParent}/${rawName}`,
            timeoutMs: options.timeoutMs ?? 120_000,
            maximumTargetBytes: MAX_PROVIDER_BYTES,
            afterModuleOpened: options.afterProviderModuleOpened,
          });
          directory.assertCurrent();
          providerSucceeded = true;
        } catch {
          throw new Error("provider generation failed");
        }
      },
    });
    let source: Buffer;
    try { source = directory.readBounded(rawName, MAX_PROVIDER_BYTES); } catch {
      throw new Error("provider output is not an allowed complete image");
    }
    await validateProviderImage(source, options.allowedFormats);
    const normalized = await normalize(source);
    directory.replace(outputName, normalized, `.${ownedTemporaryName("normalized.png")}`);
    return AttemptLedgerSchema.parse({
      ledgerVersion: 1,
      slideId: options.slideId ?? "external-slide",
      revisionId: options.revisionId ?? null,
      attempt: options.attempt,
      providerId: options.providerId ?? "external-provider",
      promptSha256: hash(options.prompt),
      promptPurged: true,
      output: resolve(outputParent, outputName),
      outputSha256: hash(normalized),
      outputBytes: normalized.length,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      quality: null,
      outcome: "generated",
      errorCode: null,
    });
  } catch (error: unknown) {
    if (!providerSucceeded && !(error instanceof Error && error.message === "provider generation failed")) {
      throw new Error("provider generation failed");
    }
    throw error;
  } finally {
    if (rawFd !== undefined) closeSync(rawFd);
    try { if (rawFd !== undefined) directory.remove(rawName); } finally { directory.close(); }
  }
}
