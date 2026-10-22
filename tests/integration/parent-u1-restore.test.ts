import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  ApiSuccessSchema,
  ContentDetailSchema,
  RevisionViewSchema,
  type AuthoringOperation,
} from "@dmall/contracts";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";
import {
  createInternalContent,
  restoreInternalRevision,
  saveInternalRevision,
} from "./internal-authoring-helpers.js";

const apps: T02cTestApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    const dataRoot = app.config.dataRoot;
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

it.each(["section", "block"] as const)("restore preserves the current %s field lock", async (kind) => {
  const app = await startT02cApp();
  apps.push(app);
  const created = createInternalContent(app, {
    schemaVersion: 1,
    title: "恢复锁回归",
    kind: "feishu_doc",
  });
  expect(created.status).toBe(201);
  const content = ApiSuccessSchema(ContentDetailSchema).parse(created.body).data;
  const rendition = content.renditions[0];
  if (rendition === undefined) throw new Error("missing rendition");
  const sectionId = randomUUID();
  const blockId = randomUUID();
  let currentId = rendition.currentRevisionId;
  const save = async (operations: AuthoringOperation[]) => {
    const response = await saveInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      baseRevisionId: currentId,
      operations,
      claims: [],
      evidenceSelections: [],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const revision = ApiSuccessSchema(RevisionViewSchema).parse(response.body).data;
    currentId = revision.id;
    return revision;
  };
  await save([{
    op: "insertNode",
    parentId: rendition.rootNodeId,
    afterId: null,
    node: {
      id: sectionId,
      title: "旧章节",
      locks: [],
      blocks: [{
        id: blockId,
        type: "paragraph",
        inlines: [{ text: "旧正文", marks: [] }],
        provenance: [],
        locks: [],
      }],
    },
  }]);
  const nodeId = kind === "section" ? sectionId : blockId;
  const path = kind === "section" ? "title" : "inlines";
  const history = await save([{ op: "setField", nodeId, path: "locks", value: [path] }]);
  await save([{ op: "setField", nodeId, path: "locks", value: [] }]);
  await save(kind === "section"
    ? [{ op: "setField", nodeId, path: "title", value: "应保留的新章节" }]
    : [{ op: "setField", nodeId, path: "inlines", value: [{ text: "应保留的新正文", marks: [] }] }]);
  await save([{ op: "setField", nodeId, path: "locks", value: [path] }]);
  const response = await restoreInternalRevision(app, rendition.id, {
    schemaVersion: 1,
    historicalRevisionId: history.id,
    expectedRevisionId: currentId,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(409);
});
