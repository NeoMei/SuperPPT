import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { LegacyResolvedDependencies } from "../dependencies/schemas.js";
import { assertGateCurrent } from "../planning/confirm.js";
import { withProjectLease } from "../project/lock.js";
import { readOwnedRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";
import {
  canonicalStyleSample,
  STYLE_SAMPLE_ARTIFACTS,
  validateCanonicalStyleSample,
  type StyleSampleArtifacts,
} from "../styles/sample-contract.js";
import { openGenerationDirectory } from "./anchored-dir.js";
import { ownedTemporaryName } from "./abandoned.js";
import { generateSlide } from "./provider.js";
import { AttemptLedgerSchema } from "./schemas.js";

const ARTIFACT_RESULT = {
  selection: STYLE_SAMPLE_ARTIFACTS[0],
  director: STYLE_SAMPLE_ARTIFACTS[1],
  prompt: STYLE_SAMPLE_ARTIFACTS[2],
  sample: STYLE_SAMPLE_ARTIFACTS[3],
  ledger: STYLE_SAMPLE_ARTIFACTS[4],
} as const;

function sampleName(path: string): string {
  return path.slice("style/sample/".length);
}

async function requirePlanningGates(root: string): Promise<void> {
  if (!await assertGateCurrent(root, "outline") || !await assertGateCurrent(root, "slide-specs")) {
    throw new Error("outline and slide-specs gates must be current before style sample generation");
  }
}

export async function generateProjectStyleSample(options: {
  root: string;
  ai: LegacyResolvedDependencies["ai"];
  runner: string;
}): Promise<{
  providerId: string;
  representativeSlideId: string;
  artifacts: typeof ARTIFACT_RESULT;
}> {
  const provider = options.ai.providers.find(({ id }) => id === options.ai.defaultProvider);
  if (!provider) throw new Error("default provider is unavailable");
  return withProjectLease(options.root, "generation", async (root) => {
    await requirePlanningGates(root);
    const canonical = await canonicalStyleSample(root);
    const revisionId = canonical.projectRevisionId;
    const sampleDirectory = openGenerationDirectory(join(root, "style", "sample"));
    const stagingName = `.style-sample-${randomUUID()}.staging`;
    const staging = sampleDirectory.child(stagingName);
    const output = join(staging.path, "sample.png");
    const cleanupNames = ["sample.png", "director.json", "prompt.txt", "ledger.json"];
    try {
      const rawLedger = await generateSlide({
        runner: options.runner,
        modulePath: join(options.ai.root, provider.module),
        callable: provider.callable,
        providerId: provider.id,
        slideId: canonical.selection.representativeSlideId,
        revisionId,
        prompt: canonical.compiled.text,
        output,
        attempt: 1,
        allowedFormats: provider.outputFormats,
        trustedRoot: staging.path,
      });
      const ledger = AttemptLedgerSchema.parse({
        ...rawLedger,
        output: STYLE_SAMPLE_ARTIFACTS[3],
      });
      staging.writeExclusive("director.json", `${JSON.stringify(canonical.director, null, 2)}\n`);
      staging.writeExclusive("prompt.txt", canonical.compiled.text);
      staging.writeExclusive("ledger.json", `${JSON.stringify(ledger, null, 2)}\n`);
      const values = {
        [STYLE_SAMPLE_ARTIFACTS[0]]: await readOwnedRegularFile(root, STYLE_SAMPLE_ARTIFACTS[0]),
        [STYLE_SAMPLE_ARTIFACTS[1]]: staging.read("director.json"),
        [STYLE_SAMPLE_ARTIFACTS[2]]: staging.read("prompt.txt"),
        [STYLE_SAMPLE_ARTIFACTS[3]]: staging.read("sample.png"),
        [STYLE_SAMPLE_ARTIFACTS[4]]: staging.read("ledger.json"),
      } as StyleSampleArtifacts;
      await validateCanonicalStyleSample(root, values);
      const current = await readProject(root);
      if (current.currentRevision.id !== revisionId) throw new Error("project revision changed during style sample generation");
      await requirePlanningGates(root);
      sampleDirectory.assertCurrent();
      for (const path of STYLE_SAMPLE_ARTIFACTS.slice(1)) {
        sampleDirectory.replace(sampleName(path), values[path], `.${ownedTemporaryName("style-sample")}`);
      }
      return {
        providerId: provider.id,
        representativeSlideId: canonical.selection.representativeSlideId,
        artifacts: ARTIFACT_RESULT,
      };
    } finally {
      for (const name of cleanupNames) {
        try { staging.remove(name); } catch { /* absent after provider failure */ }
      }
      try {
        staging.removeEmptyChild(".private");
      } finally {
        staging.close();
        try { sampleDirectory.removeEmptyChild(stagingName); } finally { sampleDirectory.close(); }
      }
    }
  });
}
