import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

export type OoxmlAttributeRange = {
  qualifiedName: string;
  namespaceUri: string;
  localName: string;
  value: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
};

export type OoxmlElementRange = {
  qualifiedName: string;
  namespaceUri: string;
  localName: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  parentStart: number | null;
  attributes: OoxmlAttributeRange[];
};

export type OoxmlRangeIndex = { xml: string; elements: OoxmlElementRange[] };

type LexicalTag = {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  raw: string;
};

function lexicalTags(xml: string): LexicalTag[] {
  const tags: LexicalTag[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) throw new Error("invalid OOXML comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0) throw new Error("invalid OOXML CDATA");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) throw new Error("invalid OOXML processing instruction");
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", start)) {
      const end = xml.indexOf(">", start + 2);
      if (end < 0) throw new Error("invalid OOXML declaration");
      cursor = end + 1;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end]!;
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= xml.length) throw new Error("invalid OOXML element");
    const raw = xml.slice(start, end + 1);
    const match = /^<\s*(\/?)\s*([^\s/>]+)/.exec(raw);
    if (!match) throw new Error("invalid OOXML tag name");
    const closing = match[1] === "/";
    const selfClosing = !closing && /\/\s*>$/.test(raw);
    tags.push({ start, openEnd: end + 1, closeStart: end + 1, end: end + 1, name: match[2]!, closing, selfClosing, raw });
    cursor = end + 1;
  }
  return tags;
}

function attributeRanges(tag: LexicalTag, attributes: Record<string, SaxesAttributeNS>): OoxmlAttributeRange[] {
  const ranges: OoxmlAttributeRange[] = [];
  let searchFrom = tag.raw.indexOf(tag.name) + tag.name.length;
  for (const attribute of Object.values(attributes)) {
    const escaped = attribute.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\s)(${escaped})\\s*=\\s*([\"'])([\\s\\S]*?)\\2`, "g");
    pattern.lastIndex = searchFrom;
    const match = pattern.exec(tag.raw);
    if (!match || match.index === undefined) throw new Error(`cannot locate OOXML attribute ${attribute.name}`);
    const leading = match[0].length - match[0].trimStart().length;
    const relativeStart = match.index + leading;
    const valueInMatch = match[0].lastIndexOf(match[3]!);
    const valueStart = tag.start + match.index + valueInMatch;
    ranges.push({
      qualifiedName: attribute.name,
      namespaceUri: attribute.uri,
      localName: attribute.local,
      value: attribute.value,
      start: tag.start + relativeStart,
      end: tag.start + match.index + match[0].length,
      valueStart,
      valueEnd: valueStart + match[3]!.length,
    });
    searchFrom = match.index + match[0].length;
  }
  return ranges;
}

export function scanOoxmlRanges(xml: string): OoxmlRangeIndex {
  const lexical = lexicalTags(xml);
  const opens = lexical.filter((tag) => !tag.closing);
  const closes = lexical.filter((tag) => tag.closing);
  let openIndex = 0;
  let closeIndex = 0;
  const stack: OoxmlElementRange[] = [];
  const elements: OoxmlElementRange[] = [];
  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on("opentag", (tag: SaxesTagNS) => {
    const lexicalTag = opens[openIndex++];
    if (!lexicalTag || lexicalTag.name !== tag.name || lexicalTag.selfClosing !== tag.isSelfClosing) {
      throw new Error("OOXML lexical and namespace parse disagree");
    }
    const element: OoxmlElementRange = {
      qualifiedName: tag.name,
      namespaceUri: tag.uri,
      localName: tag.local,
      start: lexicalTag.start,
      openEnd: lexicalTag.openEnd,
      closeStart: lexicalTag.openEnd,
      end: lexicalTag.openEnd,
      selfClosing: tag.isSelfClosing,
      parentStart: stack.at(-1)?.start ?? null,
      attributes: attributeRanges(lexicalTag, tag.attributes),
    };
    elements.push(element);
    if (!tag.isSelfClosing) stack.push(element);
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    if (tag.isSelfClosing) return;
    const lexicalTag = closes[closeIndex++];
    const element = stack.pop();
    if (!lexicalTag || !element || lexicalTag.name !== tag.name || element.qualifiedName !== tag.name) {
      throw new Error("OOXML close tag is ambiguous");
    }
    element.closeStart = lexicalTag.start;
    element.end = lexicalTag.end;
  });
  let parseError: Error | undefined;
  parser.on("error", (error) => { parseError = error; });
  parser.write(xml).close();
  if (parseError) throw new Error("invalid OOXML", { cause: parseError });
  if (stack.length > 0 || openIndex !== opens.length || closeIndex !== closes.length) {
    throw new Error("OOXML range scan is incomplete");
  }
  return { xml, elements };
}

export function extractElementRange(
  xml: string,
  namespaceUri: string,
  localName: string,
): OoxmlElementRange {
  const matches = scanOoxmlRanges(xml).elements.filter((element) =>
    element.namespaceUri === namespaceUri && element.localName === localName);
  if (matches.length !== 1) throw new Error(`expected exactly one ${localName} element`);
  return matches[0]!;
}
