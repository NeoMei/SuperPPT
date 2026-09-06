import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { readBoundedPptxArchiveFile } from './archive.js';
import { extractElementRange, scanOoxmlRanges } from './ooxml.js';
import { transplantedShapeTree, rewriteInternalImageRelationships } from './shape-tree.js';
import { atomicWrite } from '../project/task-store.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
export async function spliceTaskSlide(candidate: string, targetPart: string, donorPath: string): Promise<void> {
  const target = await readBoundedPptxArchiveFile(candidate), donor = await readBoundedPptxArchiveFile(donorPath);
  const size = async (zip: typeof target) => {
    const element = scanOoxmlRanges(await zip.file('ppt/presentation.xml')!.async('string')).elements.find(e => e.namespaceUri === P && e.localName === 'sldSz');
    return ['cx', 'cy'].map(name => Number(element?.attributes.find(a => a.localName === name)?.value));
  };
  const [width, height] = await size(target), [donorWidth, donorHeight] = await size(donor);
  // The independent converter rounds 13 1/3 inches to 13.333. Permit <=0.001 inch
  // of rounding per axis, not resizing; retain all target geometry and donor shapes.
  if (![width, height, donorWidth, donorHeight].every(n => Number.isSafeInteger(n) && n > 0)
    || Math.abs(width - donorWidth) > 914 || Math.abs(height - donorHeight) > 914
    || Math.abs((width / height) / (donorWidth / donorHeight) - 1) > 0.0001) {
    throw new Error('Donor slide dimensions differ from the complete deck');
  }
  const slides = Object.keys(donor.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (slides.length !== 1) throw new Error('Expected one donor slide');
  const donorPart = slides[0], donorXml = await donor.file(donorPart)!.async('string');
  const xml = await target.file(targetPart)?.async('string');
  if (!xml) throw new Error('Target slide missing');
  const relPath = `ppt/slides/_rels/${basename(targetPart)}.rels`;
  const relationships = await target.file(relPath)?.async('string') ?? `<Relationships xmlns="${REL}"/>`;
  const donorRels = await donor.file(`ppt/slides/_rels/${basename(donorPart)}.rels`)?.async('string') ?? `<Relationships xmlns="${REL}"/>`;
  const used = new Set(scanOoxmlRanges(relationships).elements.flatMap(e => e.attributes.filter(a => a.localName === 'Id').map(a => a.value)));
  const ids = new Map<string, string>(), additions: Array<{id: string; target: string}> = [];
  for (const rel of scanOoxmlRanges(donorRels).elements.filter(e => e.namespaceUri === REL && e.localName === 'Relationship')) {
    const attr = (n: string) => rel.attributes.find(a => a.localName === n)?.value;
    if (attr('Type') !== `${R}/image`) continue;
    if (attr('TargetMode') === 'External') throw new Error('External donor media unsupported');
    const name = posix.normalize(posix.join('ppt/slides', attr('Target')!));
    if (!name.startsWith('ppt/media/')) throw new Error('Invalid donor media path');
    const image = await donor.file(name)?.async('nodebuffer');
    if (!image) throw new Error('Donor image missing');
    let n = 1; while (used.has(`rId${n}`)) n++;
    const id = `rId${n}`, media = `superppt-${randomUUID()}.${name.split('.').at(-1)}`;
    used.add(id); ids.set(attr('Id')!, id); target.file(`ppt/media/${media}`, image);
    additions.push({ id, target: `../media/${media}` });
  }
  const tree = extractElementRange(xml, P, 'spTree');
  target.file(targetPart, xml.slice(0, tree.start) + transplantedShapeTree(donorXml, ids) + xml.slice(tree.end));
  target.file(relPath, rewriteInternalImageRelationships(relationships, additions));
  // Add donor image content-type defaults without changing notes, slide IDs or other slides.
  const ct = await target.file('[Content_Types].xml')!.async('string');
  const donorCt = await donor.file('[Content_Types].xml')!.async('string');
  const extensions = new Set([...ct.matchAll(/Extension="([^"]+)"/g)].map(m => m[1]));
  const extra = [...donorCt.matchAll(/<Default\b[^>]*\/>/g)].map(m => m[0]).filter(s => {
    const extension = /Extension="([^"]+)"/.exec(s)?.[1];
    return extension && /ContentType="image\//.test(s) && !extensions.has(extension);
  }).join('');
  target.file('[Content_Types].xml', ct.replace('</Types>', extra + '</Types>'));
  await atomicWrite(candidate, await target.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
