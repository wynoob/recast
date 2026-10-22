import { randomUUID } from "node:crypto";
import { openDatabase } from "@dmall/storage";
import { commitRevision } from "../../../dist/apps/server/authoring/revision-commit.js";

const [dbPath, boundary, existingDataRoot] = process.argv.slice(2);
if (!dbPath || !boundary) throw new Error("dbPath and boundary are required");

const opened = await openDatabase({
  dbPath,
  backupDir: `${existingDataRoot ?? dbPath}.backups`,
});
const db = opened.db;
const now = new Date().toISOString();
const contentId = randomUUID();
const renditionId = randomUUID();
const rootNodeId = randomUUID();
const baseRevisionId = randomUUID();
const ast = {
  schemaVersion: 1,
  kind: "feishu_doc",
  title: "崩溃前",
  locks: [],
  sections: [],
  speakerNotes: {},
};

db.prepare(
  "INSERT INTO contents(id, title, brief_json, merchant_id, status, version, created_at, updated_at) VALUES (?, '崩溃前', '{}', NULL, 'draft', 0, ?, ?)",
).run(contentId, now, now);
db.prepare(
  `INSERT INTO renditions
    (id, content_id, kind, label, root_node_id, current_revision_id, version, created_at, updated_at)
   VALUES (?, ?, 'feishu_doc', '主版本', ?, NULL, 0, ?, ?)`,
).run(renditionId, contentId, rootNodeId, now, now);
db.prepare(
  `INSERT INTO revisions
    (id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at)
   VALUES (?, ?, NULL, NULL, ?, 'user', '初始', ?)`,
).run(baseRevisionId, renditionId, JSON.stringify(ast), now);
db.prepare("UPDATE renditions SET current_revision_id = ? WHERE id = ?").run(baseRevisionId, renditionId);

const transaction = db.transaction(() => {
  commitRevision(db, {
    mode: "manual",
    renditionId,
    baseRevisionId,
    operations: [{
      op: "setField",
      nodeId: rootNodeId,
      path: "title",
      value: "崩溃后不应提交",
    }],
    claims: [],
    evidenceSelections: [],
    fixedEvidence: [],
    createdBy: "user",
    expectedCurrentRevisionId: baseRevisionId,
    reason: "崩溃边界探针",
  }, (stage) => {
    if (stage === boundary) process.kill(process.pid, "SIGKILL");
  });
});
transaction.immediate();
db.close();
