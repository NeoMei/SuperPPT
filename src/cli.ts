import { preflightDependencies } from "./dependencies/preflight.js";
import { resolveDependencies } from "./dependencies/resolve.js";

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== "preflight") {
    throw new Error("usage: superppt preflight");
  }
  const aiRoot = process.env.SUPERPPT_AI_IMAGE_TO_PPT_SOURCE;
  const editableRoot = process.env.SUPERPPT_IMAGE_TO_EDITABLE_PPTX_SOURCE;
  if (!aiRoot || !editableRoot) {
    throw new Error("both dependency source overrides are required by the initial CLI");
  }
  const report = await preflightDependencies(await resolveDependencies({ aiRoot, editableRoot }));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
