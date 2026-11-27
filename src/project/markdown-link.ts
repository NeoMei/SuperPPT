import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Build a Markdown link that survives paths with spaces, Unicode, fragments, and query characters. */
export const markdownFileLink = (label: string, filePath: string): string => (
  `[${label}](<${pathToFileURL(filePath).href}>)`
);

export const markdownNamedFileLink = (filePath: string): string => (
  markdownFileLink(basename(filePath), filePath)
);
