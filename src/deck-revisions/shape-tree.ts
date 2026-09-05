import { extractElementRange, scanOoxmlRanges, type OoxmlElementRange } from "./ooxml.js";
const P="http://schemas.openxmlformats.org/presentationml/2006/main";
const R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL="http://schemas.openxmlformats.org/package/2006/relationships";
const XML_NAMESPACE="http://www.w3.org/XML/1998/namespace";
function xmlAttribute(element: OoxmlElementRange, namespaceUri: string, localName: string): string | null {
  const matches = element.attributes.filter((attribute) =>
    attribute.namespaceUri === namespaceUri && attribute.localName === localName);
  if (matches.length > 1) throw new Error(`duplicate OOXML ${localName} attribute`);
  return matches[0]?.value ?? null;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function replaceRanges(source: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

type NamespaceDeclaration = { raw: string; uri: string };

function namespaceDeclarations(opening: string): Map<string, NamespaceDeclaration> {
  const declarations = new Map<string, NamespaceDeclaration>();
  for (const match of opening.matchAll(/\s+xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const prefix = match[1] ?? "";
    if (declarations.has(prefix)) throw new Error(`duplicate namespace declaration for prefix ${prefix || "<default>"}`);
    declarations.set(prefix, { raw: match[0]!.trim(), uri: match[2] ?? match[3] ?? "" });
  }
  return declarations;
}

export function transplantedShapeTree(
  donorXml: string,
  relationshipIds: Map<string, string>,
): string {
  const range = extractElementRange(donorXml, P, "spTree");
  const donorElements = scanOoxmlRanges(donorXml).elements;
  const descendants = donorElements.filter((element) =>
    element.start >= range.start && element.end <= range.end);
  const replacements = descendants.flatMap((element) => element.attributes.flatMap((attribute) => {
    if (attribute.namespaceUri !== R || attribute.localName !== "embed") return [];
    const next = relationshipIds.get(attribute.value);
    if (!next) throw new Error(`donor shape tree has unauthenticated image relationship ${attribute.value}`);
    return [{ start: attribute.valueStart - range.start, end: attribute.valueEnd - range.start, value: next }];
  }));
  let shapeTree = replaceRanges(donorXml.slice(range.start, range.end), replacements);
  const byStart = new Map(donorElements.map((element) => [element.start, element] as const));
  const declarationAt = (element: OoxmlElementRange, prefix: string) =>
    namespaceDeclarations(donorXml.slice(element.start, element.openEnd)).get(prefix);
  const localDeclaration = (element: OoxmlElementRange, prefix: string): NamespaceDeclaration | undefined => {
    let current: OoxmlElementRange | undefined = element;
    while (current && current.start >= range.start) {
      const declaration = declarationAt(current, prefix);
      if (declaration) return declaration;
      current = current.parentStart === null ? undefined : byStart.get(current.parentStart);
    }
    return undefined;
  };
  const inheritedDeclaration = (prefix: string): NamespaceDeclaration | undefined => {
    let current = range.parentStart === null ? undefined : byStart.get(range.parentStart);
    while (current) {
      const declaration = declarationAt(current, prefix);
      if (declaration) return declaration;
      current = current.parentStart === null ? undefined : byStart.get(current.parentStart);
    }
    return undefined;
  };
  const requiredDeclarations = new Map<string, NamespaceDeclaration>();
  const requireNamespace = (element: OoxmlElementRange, prefix: string, uri: string): void => {
    if (prefix === "xml" && uri === XML_NAMESPACE) return;
    const local = localDeclaration(element, prefix);
    if (local) {
      if (local.uri !== uri) throw new Error(`donor shape tree namespace binding disagrees for prefix ${prefix || "<default>"}`);
      return;
    }
    const inherited = inheritedDeclaration(prefix);
    if (!inherited || inherited.uri !== uri) throw new Error(`donor shape tree uses undeclared namespace prefix ${prefix}`);
    const previous = requiredDeclarations.get(prefix);
    if (previous && previous.uri !== inherited.uri) throw new Error(`donor shape tree has ambiguous namespace prefix ${prefix || "<default>"}`);
    requiredDeclarations.set(prefix, inherited);
  };
  for (const element of descendants) {
    if (element.namespaceUri) {
      const separator = element.qualifiedName.indexOf(":");
      requireNamespace(element, separator < 0 ? "" : element.qualifiedName.slice(0, separator), element.namespaceUri);
    }
    for (const attribute of element.attributes) {
      const separator = attribute.qualifiedName.indexOf(":");
      if (separator > 0 && attribute.qualifiedName.slice(0, separator) !== "xmlns" && attribute.namespaceUri) {
        requireNamespace(element, attribute.qualifiedName.slice(0, separator), attribute.namespaceUri);
      }
    }
  }
  const declarations = [...requiredDeclarations.values()].map((declaration) => declaration.raw);
  if (declarations.length > 0) {
    const openEnd = shapeTree.indexOf(">");
    if (openEnd < 0) throw new Error("donor shape tree opening tag is invalid");
    const insertion = shapeTree[openEnd - 1] === "/" ? openEnd - 1 : openEnd;
    shapeTree = `${shapeTree.slice(0, insertion)} ${declarations.join(" ")}${shapeTree.slice(insertion)}`;
  }
  return shapeTree;
}

function stagedRelationshipElements(xml: string): OoxmlElementRange[] {
  const elements = scanOoxmlRanges(xml).elements;
  const documentRoots = elements.filter((element) => element.parentStart === null);
  const root = documentRoots[0];
  if (documentRoots.length !== 1 || !root || root.namespaceUri !== REL || root.localName !== "Relationships") {
    throw new Error("staged relationship document must have one strict package Relationships root");
  }
  const relationships = elements.filter((element) => element.parentStart === root.start);
  if (
    relationships.some((element) => element.namespaceUri !== REL || element.localName !== "Relationship")
    || elements.length !== relationships.length + 1
  ) throw new Error("staged relationship document contains a foreign or nested child");
  const prefix = xml.slice(0, root.start).replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>/, "");
  if (prefix.trim() || xml.slice(root.end).trim()) throw new Error("staged relationship document has ambiguous text outside its root");
  let cursor = root.openEnd;
  for (const relationship of [...relationships].sort((left, right) => left.start - right.start)) {
    if (xml.slice(cursor, relationship.start).trim()) throw new Error("staged relationship document has ambiguous root content");
    if (!relationship.selfClosing && xml.slice(relationship.openEnd, relationship.closeStart).trim()) {
      throw new Error("staged relationship document has ambiguous relationship content");
    }
    cursor = relationship.end;
  }
  if (!root.selfClosing && xml.slice(cursor, root.closeStart).trim()) throw new Error("staged relationship document has ambiguous root content");
  return relationships;
}

export function rewriteInternalImageRelationships(
  relationshipsXml: string,
  additions: Array<{ id: string; target: string }>,
): string {
  stagedRelationshipElements(relationshipsXml);
  const root = extractElementRange(relationshipsXml, REL, "Relationships");
  const children = additions.map(({ id, target }) =>
    `<Relationship xmlns="${REL}" Id="${escapeAttribute(id)}" Type="${R}/image" Target="${escapeAttribute(target)}"/>`).join("");
  if (root.selfClosing) {
    const opening = relationshipsXml.slice(root.start, root.openEnd);
    const paired = `${opening.replace(/\/\s*>$/, ">")}${children}</${root.qualifiedName}>`;
    return `${relationshipsXml.slice(0, root.start)}${paired}${relationshipsXml.slice(root.end)}`;
  }
  return `${relationshipsXml.slice(0, root.closeStart)}${children}${relationshipsXml.slice(root.closeStart)}`;
}
