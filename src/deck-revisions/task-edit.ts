import { z } from 'zod';
import { scanOoxmlRanges, type OoxmlElementRange } from './ooxml.js';
import { EditOperationSchema, type EditOperation } from '../editable/operations.js';
import { EditableManifestV2Schema, type EditableManifestV2 } from '../editable/schemas.js';
import { readBoundedPptxArchiveFile } from './archive.js';
import { atomicWrite } from '../project/task-store.js';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
class UnsupportedEditableTargetError extends Error {}
function attribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  const matches = element.attributes.filter((item) => item.namespaceUri === namespaceUri && item.localName === localName);
  if (matches.length > 1) throw new Error(`duplicate OOXML ${localName} attribute`);
  return matches[0]?.value ?? null;
}

function replaceRanges(source: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unescapeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function officialObjectName(element: EditableManifestV2["elements"][number]): string {
  if (element.kind === "text") return `text-${element.id}`;
  if (element.kind === "shape") return `shape-${element.id}-${element.label}`;
  return `asset-${element.id}`;
}

type CurrentObject = {
  name: string;
  owner: OoxmlElementRange;
  elements: OoxmlElementRange[];
};

function currentObject(xml: string, manifest: EditableManifestV2, operation: EditOperation): CurrentObject {
  const manifestElement = manifest.elements.find((candidate) => candidate.id === operation.elementId);
  if (!manifestElement) throw new UnsupportedEditableTargetError(`target is absent from the editable manifest: ${operation.elementId}`);
  const expectedKind = operation.kind === "replace-text" || operation.kind === "set-text-style"
    ? "text"
    : operation.kind === "move-shape" || operation.kind === "set-shape-style"
      ? "shape"
      : "asset";
  if (manifestElement.kind !== expectedKind) {
    throw new UnsupportedEditableTargetError(`${operation.kind} requires a current ${expectedKind} object`);
  }
  const name = officialObjectName(manifestElement);
  const elements = scanOoxmlRanges(xml).elements;
  const byStart = new Map(elements.map((element) => [element.start, element] as const));
  const named = elements.filter((element) =>
    element.namespaceUri === P && element.localName === "cNvPr" && attribute(element, "", "name") === name);
  if (named.length !== 1) throw new UnsupportedEditableTargetError(`current slide does not contain exactly one official object named ${name}`);
  const nonVisual = named[0]!.parentStart === null ? undefined : byStart.get(named[0]!.parentStart);
  const owner = nonVisual?.parentStart === null || nonVisual?.parentStart === undefined
    ? undefined
    : byStart.get(nonVisual.parentStart);
  const requiredOwner = expectedKind === "asset" ? "pic" : "sp";
  if (!owner || owner.namespaceUri !== P || owner.localName !== requiredOwner) {
    throw new UnsupportedEditableTargetError(`current object ${name} is not the expected ${requiredOwner} OOXML type`);
  }
  const descendants = elements.filter((element) => element.start >= owner.start && element.end <= owner.end);
  if (expectedKind === "text" && !descendants.some((element) => element.namespaceUri === P && element.localName === "txBody")) {
    throw new UnsupportedEditableTargetError(`current object ${name} is not a text shape`);
  }
  return { name, owner, elements: descendants };
}

function replaceText(xml: string, object: CurrentObject, text: string): string {
  const nodes = object.elements.filter((element) => element.namespaceUri === A && element.localName === "t");
  if (nodes.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no DrawingML text nodes`);
  if (nodes.some((node) => node.selfClosing)) throw new UnsupportedEditableTargetError(`current text object ${object.name} has a self-closing text node`);
  let remaining = text;
  const replacements = nodes.map((node, index) => {
    const currentLength = unescapeXmlText(xml.slice(node.openEnd, node.closeStart)).length;
    const next = index === nodes.length - 1 ? remaining : remaining.slice(0, currentLength);
    remaining = remaining.slice(next.length);
    return { start: node.openEnd, end: node.closeStart, value: escapeXmlText(next) };
  });
  return replaceRanges(xml, replacements);
}

function replaceAttributeValue(
  xml: string,
  elements: OoxmlElementRange[],
  namespaceUri: string,
  localName: string,
  attributeName: string,
  value: string,
  label: string,
): string {
  const matches = elements.filter((element) => element.namespaceUri === namespaceUri && element.localName === localName);
  if (matches.length !== 1) throw new UnsupportedEditableTargetError(`${label} is missing or ambiguous on the current object`);
  const attributes = matches[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === attributeName);
  if (attributes.length !== 1) throw new UnsupportedEditableTargetError(`${label} attribute is missing or ambiguous on the current object`);
  return replaceRanges(xml, [{ start: attributes[0]!.valueStart, end: attributes[0]!.valueEnd, value }]);
}

function shapePropertyElements(object: CurrentObject): OoxmlElementRange[] {
  const shapeProperties = object.elements.filter((element) => element.namespaceUri === P && element.localName === "spPr" && element.parentStart === object.owner.start);
  if (shapeProperties.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has ambiguous shape properties`);
  return object.elements.filter((element) => element.start >= shapeProperties[0]!.start && element.end <= shapeProperties[0]!.end);
}

function hexColor(value: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new UnsupportedEditableTargetError("OOXML direct color edits require a six-digit RGB color");
  return match[1]!.toUpperCase();
}

function setShapeStyle(xml: string, object: CurrentObject, operation: Extract<EditOperation, { kind: "set-shape-style" }>): string {
  let result = xml;
  const patchColor = (input: string, line: boolean, value: string): string => {
    const refreshed = scanOoxmlRanges(input).elements;
    const owner = refreshed.find((element) => element.start === object.owner.start);
    if (!owner) throw new Error("current object range changed unexpectedly");
    const descendants = refreshed.filter((element) => element.start >= owner.start && element.end <= owner.end);
    const spPr = descendants.filter((element) => element.namespaceUri === P && element.localName === "spPr" && element.parentStart === owner.start);
    if (spPr.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has ambiguous shape properties`);
    const scopeRoot = line
      ? descendants.find((element) => element.namespaceUri === A && element.localName === "ln" && element.parentStart === spPr[0]!.start)
      : spPr[0];
    if (!scopeRoot) throw new UnsupportedEditableTargetError(`current object ${object.name} has no supported ${line ? "stroke" : "fill"}`);
    const scope = descendants.filter((element) => element.start >= scopeRoot.start && element.end <= scopeRoot.end);
    const fills = scope.filter((element) => element.namespaceUri === A && element.localName === "solidFill" && element.parentStart === scopeRoot.start);
    if (fills.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has no single solid ${line ? "stroke" : "fill"}`);
    const colors = scope.filter((element) => element.namespaceUri === A && element.localName === "srgbClr" && element.parentStart === fills[0]!.start);
    if (colors.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has no single RGB ${line ? "stroke" : "fill"}`);
    const attr = colors[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === "val");
    if (attr.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} RGB value is ambiguous`);
    return replaceRanges(input, [{ start: attr[0]!.valueStart, end: attr[0]!.valueEnd, value: hexColor(value) }]);
  };
  if (operation.fillColor !== undefined) result = patchColor(result, false, operation.fillColor);
  if (operation.strokeColor !== undefined) result = patchColor(result, true, operation.strokeColor);
  if (operation.strokeWidthPx !== undefined) {
    const refreshedObject = currentObjectByName(result, object.name, "sp");
    const properties = shapePropertyElements(refreshedObject);
    result = replaceAttributeValue(result, properties, A, "ln", "w", String(Math.round(operation.strokeWidthPx * 9525)), "shape stroke width");
  }
  return result;
}

function currentObjectByName(xml: string, name: string, requiredOwner: "sp" | "pic"): CurrentObject {
  const elements = scanOoxmlRanges(xml).elements;
  const byStart = new Map(elements.map((element) => [element.start, element] as const));
  const named = elements.filter((element) => element.namespaceUri === P && element.localName === "cNvPr" && attribute(element, "", "name") === name);
  if (named.length !== 1) throw new UnsupportedEditableTargetError(`current slide does not contain exactly one official object named ${name}`);
  const nonVisual = named[0]!.parentStart === null ? undefined : byStart.get(named[0]!.parentStart);
  const owner = nonVisual?.parentStart === null || nonVisual?.parentStart === undefined ? undefined : byStart.get(nonVisual.parentStart);
  if (!owner || owner.namespaceUri !== P || owner.localName !== requiredOwner) throw new UnsupportedEditableTargetError(`current object ${name} changed type`);
  return { name, owner, elements: elements.filter((element) => element.start >= owner.start && element.end <= owner.end) };
}

function moveObject(xml: string, object: CurrentObject, bbox: { x: number; y: number; width: number; height: number }): string {
  const properties = shapePropertyElements(object);
  const transforms = properties.filter((element) => element.namespaceUri === A && element.localName === "xfrm");
  if (transforms.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has no single transform`);
  const scope = properties.filter((element) => element.start >= transforms[0]!.start && element.end <= transforms[0]!.end);
  const off = scope.filter((element) => element.namespaceUri === A && element.localName === "off" && element.parentStart === transforms[0]!.start);
  const ext = scope.filter((element) => element.namespaceUri === A && element.localName === "ext" && element.parentStart === transforms[0]!.start);
  if (off.length !== 1 || ext.length !== 1) throw new UnsupportedEditableTargetError(`current object ${object.name} has an ambiguous transform`);
  const values = new Map([["x", bbox.x], ["y", bbox.y], ["cx", bbox.width], ["cy", bbox.height]] as const);
  const replacements = [
    ...off[0]!.attributes.filter((item) => values.has(item.localName as "x" | "y" | "cx" | "cy")),
    ...ext[0]!.attributes.filter((item) => values.has(item.localName as "x" | "y" | "cx" | "cy")),
  ].map((item) => ({
    start: item.valueStart,
    end: item.valueEnd,
    value: String(Math.round(values.get(item.localName as "x" | "y" | "cx" | "cy")! * 9525)),
  }));
  if (replacements.length !== 4) throw new UnsupportedEditableTargetError(`current object ${object.name} transform attributes are incomplete`);
  return replaceRanges(xml, replacements);
}

function setTextStyle(xml: string, object: CurrentObject, operation: Extract<EditOperation, { kind: "set-text-style" }>): string {
  let result = xml;
  const refresh = () => currentObjectByName(result, object.name, "sp");
  if (operation.align !== undefined) {
    const current = refresh();
    const paragraphs = current.elements.filter((element) => element.namespaceUri === A && element.localName === "p");
    if (paragraphs.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no paragraphs`);
    const replacements = paragraphs.map((paragraph) => {
      const properties = current.elements.filter((element) => element.namespaceUri === A && element.localName === "pPr" && element.parentStart === paragraph.start);
      if (properties.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit paragraph alignment`);
      const alignment = properties[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === "algn");
      if (alignment.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit paragraph alignment`);
      return {
        start: alignment[0]!.valueStart,
        end: alignment[0]!.valueEnd,
        value: { left: "l", center: "ctr", right: "r" }[operation.align!],
      };
    });
    result = replaceRanges(result, replacements);
  }
  if (operation.bold !== undefined || operation.fontSizePx !== undefined) {
    const current = refresh();
    const runProperties = current.elements.filter((element) => element.namespaceUri === A && element.localName === "rPr");
    if (runProperties.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no explicit run formatting`);
    const replacements = runProperties.flatMap((properties) => {
      const values: Array<{ name: string; value: string }> = [];
      if (operation.bold !== undefined) values.push({ name: "b", value: operation.bold ? "1" : "0" });
      if (operation.fontSizePx !== undefined) values.push({ name: "sz", value: String(Math.round(operation.fontSizePx * 75)) });
      return values.map(({ name, value }) => {
        const matches = properties.attributes.filter((item) => item.namespaceUri === "" && item.localName === name);
        if (matches.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit ${name} run property`);
        return { start: matches[0]!.valueStart, end: matches[0]!.valueEnd, value };
      });
    });
    result = replaceRanges(result, replacements);
  }
  if (operation.color !== undefined) {
    const current = refresh();
    const runProperties = current.elements.filter((element) => element.namespaceUri === A && element.localName === "rPr");
    const replacements = runProperties.map((properties) => {
      const fills = current.elements.filter((element) => element.namespaceUri === A && element.localName === "solidFill" && element.parentStart === properties.start);
      if (fills.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit solid run fill`);
      const colors = current.elements.filter((element) => element.namespaceUri === A && element.localName === "srgbClr" && element.parentStart === fills[0]!.start);
      if (colors.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no single explicit RGB run fill`);
      const value = colors[0]!.attributes.filter((item) => item.namespaceUri === "" && item.localName === "val");
      if (value.length !== 1) throw new UnsupportedEditableTargetError(`current text object ${object.name} has an ambiguous run color`);
      return { start: value[0]!.valueStart, end: value[0]!.valueEnd, value: hexColor(operation.color!) };
    });
    if (replacements.length === 0) throw new UnsupportedEditableTargetError(`current text object ${object.name} has no explicit run colors`);
    result = replaceRanges(result, replacements);
  }
  return result;
}

function applyOperation(xml: string, manifest: EditableManifestV2, operation: EditOperation): string {
  const object = currentObject(xml, manifest, operation);
  if (operation.kind === "replace-text") return replaceText(xml, object, operation.text);
  if (operation.kind === "set-text-style") return setTextStyle(xml, object, operation);
  if (operation.kind === "set-shape-style") return setShapeStyle(xml, object, operation);
  if (operation.kind === "move-shape" || operation.kind === "move-asset") return moveObject(xml, object, operation.bbox);
  throw new UnsupportedEditableTargetError(`${operation.kind} is not safely supported against current OOXML yet`);
}


export async function applySlideOperations(path: string, slidePart: string, rawManifest: unknown, rawOperations: unknown): Promise<void> {
  const manifest = EditableManifestV2Schema.parse(rawManifest);
  const operations = z.array(EditOperationSchema).min(1).max(100).parse(rawOperations);
  const zip = await readBoundedPptxArchiveFile(path);
  let xml = await zip.file(slidePart)?.async('string');
  if (!xml) throw new Error('Target slide missing');
  for (const operation of operations) xml = applyOperation(xml, manifest, operation);
  zip.file(slidePart, xml);
  await atomicWrite(path, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
}
