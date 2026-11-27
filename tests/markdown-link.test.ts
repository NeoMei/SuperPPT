import test from 'node:test';
import assert from 'node:assert/strict';

import { markdownFileLink } from '../src/project/markdown-link.js';

test('encodes local file paths before embedding them in Markdown links', () => {
  const windows = process.platform === 'win32';
  const filePath = windows ? 'D:\\tmp\\新 PPT\\report #1.pptx' : '/tmp/新 PPT/report #1.pptx';
  const prefix = windows ? 'file:///D:/tmp/' : 'file:///tmp/';
  assert.equal(
    markdownFileLink('deck.pptx', filePath),
    `[deck.pptx](<${prefix}%E6%96%B0%20PPT/report%20%231.pptx>)`,
  );
});
