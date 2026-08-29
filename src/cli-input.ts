import type { z } from "zod";

import {
  readAnchoredRegularFile,
  type SafeReadOperations,
} from "./project/safe-file.js";

export const MAX_CLI_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_CLI_TEXT_BYTES = 16 * 1024 * 1024;

export type CliInputOptions = {
  privateInput?: boolean;
  maxBytes?: number;
  operations?: SafeReadOperations;
};

export async function readCliJsonInput<T>(
  path: string,
  label: string,
  schema: z.ZodType<T>,
  options: CliInputOptions = {},
): Promise<T> {
  let bytes: Buffer;
  try {
    bytes = await readAnchoredRegularFile(path, {
      label,
      maxBytes: options.maxBytes ?? MAX_CLI_JSON_BYTES,
      privateInput: options.privateInput,
      operations: options.operations,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === `${label} file must be private (mode 0600)`) throw error;
    throw new Error(`${label} file is unsafe or invalid`, { cause: error });
  }
  try {
    return schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error(`${label} file is unsafe or invalid`, { cause: error });
  }
}
