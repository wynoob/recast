import { XMLParser, XMLValidator } from "fast-xml-parser";
import { LocalAdapterError } from "./contracts.js";

const PREDEFINED = new Map([
  ["&amp;", "&"], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'], ["&apos;", "'"],
]);

function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);|&/gu, entity => {
    const predefined = PREDEFINED.get(entity);
    if (predefined !== undefined) return predefined;
    if (entity === "&") throw new Error("XML 含未知或不完整的实体引用");
    const hex = entity.startsWith("&#x");
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (!(code === 9 || code === 10 || code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff))) {
      throw new Error("XML 数字实体不是有效的 XML 1.0 字符");
    }
    return String.fromCodePoint(code);
  });
}

function rejectCustomEntities(entities: Record<string, string>): void {
  if (Object.keys(entities).length > 0) throw new Error("不允许自定义 XML 实体");
}

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  entityDecoder: {
    decode: decodeXmlText,
    setExternalEntities: rejectCustomEntities,
    addInputEntities: rejectCustomEntities,
    reset: () => {},
    setXmlVersion: () => {},
  },
  ignoreDeclaration: true,
});

export function parseSafeXml(text: string): unknown {
  try {
    if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error("不允许 DOCTYPE 或 ENTITY");
    const validation = XMLValidator.validate(text);
    if (validation !== true) throw new Error(validation.err.msg);
    const result: unknown = PARSER.parse(text);
    return result;
  } catch (error: unknown) {
    throw new LocalAdapterError("SOURCE_UNREADABLE", "XML 解析失败", { cause: error });
  }
}
