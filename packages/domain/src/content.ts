import {
  BriefSchema,
  DocAstSchema,
  DeckAstSchema,
  SchemaVersionSchema,
  type Ast,
  type Brief,
  type BriefInput,
  type ContentKind,
} from "@dmall/contracts";

export function createBrief(input: BriefInput, ids: { contentId: string; kind: ContentKind }): Brief {
  return BriefSchema.parse({
    schemaVersion: SchemaVersionSchema.value,
    contentId: ids.contentId,
    targetKind: ids.kind,
    ...input,
  });
}

export function createEmptyAst(input: { kind: ContentKind; title: string }): Ast {
  if (input.kind === "feishu_doc") {
    return DocAstSchema.parse({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: input.title,
      locks: [],
      sections: [],
      speakerNotes: {},
    });
  }

  return DeckAstSchema.parse({
    schemaVersion: 1,
    kind: "html_deck",
    title: input.title,
    locks: [],
    canvas: { width: 1600, height: 900 },
    slides: [],
  });
}
