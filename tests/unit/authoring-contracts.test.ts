import { describe, expect, it } from "vitest";
import {
  AuthoringOperationSchema,
  LocalFileLocatorSchema,
  LocatorSchema,
  OccurrenceLocatorSchema,
  MarkdownLocatorSchema,
  parseEditOperation,
} from "@dmall/contracts";

const nodeId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";

describe("shared authoring contracts", () => {
  it("preserves both legacy occurrence locator JSON shapes in the shared leaf", () => {
    const localFile = {
      schemaVersion: 1,
      kind: "local_file",
      relativePath: "assets/品牌/logo.png",
    };
    const markdown = {
      schemaVersion: 1,
      kind: "markdown",
      line: 8,
      column: 3,
      ordinal: 2,
      rawTarget: "../assets/logo.png",
      normalizedRelativePath: "assets/logo.png",
      resolution: "inside_root",
    };
    expect(LocalFileLocatorSchema.parse(localFile)).toEqual(localFile);
    expect(MarkdownLocatorSchema.parse(markdown)).toEqual(markdown);
    expect(OccurrenceLocatorSchema.parse(localFile)).toEqual(localFile);
    expect(OccurrenceLocatorSchema.parse(markdown)).toEqual(markdown);
    expect(LocatorSchema.parse(localFile)).toEqual(localFile);
    expect(LocatorSchema.parse(markdown)).toEqual(markdown);
  });

  it("keeps the four canonical AST locator branches strict", () => {
    expect(LocatorSchema.parse({ kind: "block", blockId: "b-1" })).toEqual({ kind: "block", blockId: "b-1" });
    expect(LocatorSchema.parse({ kind: "page", page: 2 })).toEqual({ kind: "page", page: 2 });
    expect(LocatorSchema.parse({ kind: "dom", domPath: "main > p" })).toEqual({ kind: "dom", domPath: "main > p" });
    expect(LocatorSchema.parse({ kind: "time", startMs: 20, endMs: 40 })).toEqual({ kind: "time", startMs: 20, endMs: 40 });
    expect(() => LocatorSchema.parse({ kind: "page", page: 0 })).toThrow();
    expect(() => LocatorSchema.parse({ kind: "unknown", value: "x" })).toThrow();
  });

  it("requires exactly one structural anchor and keeps afterId:null as append", () => {
    const node = {
      id: otherId,
      type: "heading",
      level: 2,
      text: "新增",
      locks: [],
      provenance: [],
    };
    expect(parseEditOperation({
      op: "insertNode",
      parentId: nodeId,
      afterId: null,
      node,
    })).toMatchObject({ afterId: null });
    expect(parseEditOperation({
      op: "insertNode",
      parentId: nodeId,
      beforeId: otherId,
      node,
    })).toMatchObject({ beforeId: otherId });
    expect(() => parseEditOperation({
      op: "insertNode",
      parentId: nodeId,
      afterId: null,
      beforeId: otherId,
      node,
    })).toThrow();
    expect(() => parseEditOperation({
      op: "moveNode",
      nodeId: otherId,
      parentId: nodeId,
    })).toThrow();
    expect(() => parseEditOperation({
      op: "moveNode",
      nodeId: otherId,
      parentId: nodeId,
      afterId: null,
      beforeId: nodeId,
    })).toThrow();
  });

  it("derives the operation type from the same schema", () => {
    const parsed = AuthoringOperationSchema.parse({
      op: "setField",
      nodeId,
      path: "provenance",
      value: [{
        kind: "source",
        sourceVersionId: otherId,
        locator: { kind: "block", blockId: "b-1" },
      }],
    });
    expect(parsed.op).toBe("setField");
    if (parsed.op === "setField" && parsed.path === "provenance") {
      expect(parsed.value).toHaveLength(1);
    }
  });
});
