import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { AttemptLedgerSchema } from "../../src/generation/schemas.js";
import { canonicalStyleSample, STYLE_SAMPLE_ARTIFACTS } from "../../src/styles/sample-contract.js";

export async function writeCanonicalStyleSample(root: string, providerId = "fixture-provider"): Promise<void> {
  const canonical = await canonicalStyleSample(root);
  const sample = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: "#102030" },
  }).png().toBuffer();
  const ledger = AttemptLedgerSchema.parse({
    ledgerVersion: 1,
    slideId: canonical.selection.representativeSlideId,
    revisionId: canonical.projectRevisionId,
    attempt: 1,
    providerId,
    promptSha256: canonical.compiled.sha256,
    promptPurged: true,
    output: STYLE_SAMPLE_ARTIFACTS[3],
    outputSha256: createHash("sha256").update(sample).digest("hex"),
    outputBytes: sample.length,
    durationMs: 0,
    quality: null,
    outcome: "generated",
    errorCode: null,
  });
  await Promise.all([
    writeFile(join(root, STYLE_SAMPLE_ARTIFACTS[1]), `${JSON.stringify(canonical.director, null, 2)}\n`),
    writeFile(join(root, STYLE_SAMPLE_ARTIFACTS[2]), canonical.compiled.text, { mode: 0o600 }),
    writeFile(join(root, STYLE_SAMPLE_ARTIFACTS[3]), sample),
    writeFile(join(root, STYLE_SAMPLE_ARTIFACTS[4]), `${JSON.stringify(ledger, null, 2)}\n`),
  ]);
}
