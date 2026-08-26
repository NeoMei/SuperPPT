import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { generateSlide } from "../../src/generation/provider.js";

const [root, runner, modulePath, privateMarker] = process.argv.slice(2);
if (!root || !runner || !modulePath || !privateMarker) throw new Error("invalid orphan probe arguments");

await generateSlide({
  runner,
  modulePath,
  callable: "gen",
  prompt: "ORPHAN_PRIVATE_PROMPT_SENTINEL",
  output: join(root, "slide.png"),
  trustedRoot: root,
  attempt: 1,
  timeoutMs: 60_000,
  beforeExecute: async (privatePath) => {
    await writeFile(privateMarker, privatePath);
  },
});
