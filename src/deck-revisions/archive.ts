import JSZip from "jszip";

import { readRegularFileNoFollow, type SafeReadOperations } from "../project/safe-file.js";

export const MAX_PPTX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PPTX_ARCHIVE_ENTRIES = 4096;
const MAX_PPTX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_PPTX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MIN_RATIO_CHECK_BYTES = 8 * 1024 * 1024;
const MAX_PPTX_ARCHIVE_EXPANSION_RATIO = 500;

type LoadedZipEntry = {
  _data?: {
    compressedSize?: unknown;
    uncompressedSize?: unknown;
  };
};

function archiveEntrySizes(entry: JSZip.JSZipObject, name: string): {
  compressedSize: number;
  uncompressedSize: number;
} {
  const data = (entry as unknown as LoadedZipEntry)._data;
  const compressedSize = data?.compressedSize;
  const uncompressedSize = data?.uncompressedSize;
  if (
    !Number.isSafeInteger(compressedSize)
    || !Number.isSafeInteger(uncompressedSize)
    || (compressedSize as number) < 0
    || (uncompressedSize as number) < 0
  ) throw new Error(`PPTX archive entry has unavailable expansion metadata: ${name}`);
  return { compressedSize: compressedSize as number, uncompressedSize: uncompressedSize as number };
}

function assertArchiveExpansionBudget(zip: JSZip): void {
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  if (entries.length > MAX_PPTX_ARCHIVE_ENTRIES) {
    throw new Error(`PPTX archive entry budget exceeded (${entries.length} > ${MAX_PPTX_ARCHIVE_ENTRIES})`);
  }
  let totalUncompressed = 0;
  for (const [name, entry] of entries) {
    if (
      /(?:^|\/)vbaProject(?:Signature)?\.bin$/i.test(name)
      || /^ppt\/(?:activeX|embeddings|externalLinks)\//i.test(name)
      || /^customUI\//i.test(name)
      || /^ppt\/connections\.xml$/i.test(name)
    ) throw new Error(`PPTX archive contains unsupported active content: ${name}`);
    const { compressedSize, uncompressedSize } = archiveEntrySizes(entry, name);
    if (uncompressedSize > MAX_PPTX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`PPTX archive entry expansion budget exceeded: ${name}`);
    }
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > MAX_PPTX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("PPTX archive total expansion budget exceeded");
    }
    if (
      uncompressedSize >= MIN_RATIO_CHECK_BYTES
      && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_PPTX_ARCHIVE_EXPANSION_RATIO)
    ) throw new Error(`PPTX archive expansion ratio budget exceeded: ${name}`);
  }
}

export async function loadBoundedPptxArchive(bytes: Buffer): Promise<JSZip> {
  if (bytes.length <= 0 || bytes.length > MAX_PPTX_ARCHIVE_BYTES) {
    throw new Error("PPTX archive compressed size budget exceeded");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error: unknown) {
    throw new Error("PPTX archive is invalid", { cause: error });
  }
  assertArchiveExpansionBudget(zip);
  return zip;
}

export async function readBoundedPptxArchiveFile(
  path: string,
  operations: SafeReadOperations = {},
): Promise<JSZip> {
  return loadBoundedPptxArchive(await readBoundedPptxFile(path, operations));
}

export async function readBoundedPptxFile(
  path: string,
  operations: SafeReadOperations = {},
): Promise<Buffer> {
  const maximum = Math.min(operations.maxBytes ?? MAX_PPTX_ARCHIVE_BYTES, MAX_PPTX_ARCHIVE_BYTES);
  return readRegularFileNoFollow(path, { ...operations, maxBytes: maximum });
}
