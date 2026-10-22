import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { ContentDetailSchema } from "@dmall/contracts";
import { startT02cApp } from "./t02c-test-helpers.js";

it("retires the old public writing chain while keeping metadata creation, history and provider management", async () => {
  const app = await startT02cApp();
  try {
    const content = z.object({ data: ContentDetailSchema }).parse(await app.writeJson("POST", "/api/v1/contents", { schemaVersion: 1, title: "历史内容", kind: "feishu_doc" })).data;
    const rendition = content.renditions[0]!;
    const candidateId = randomUUID();
    const paths = [
      `/api/v1/renditions/${rendition.id}/revisions`, `/api/v1/renditions/${rendition.id}/restore`,
      `/api/v1/renditions/${rendition.id}/generation-inputs`, `/api/v1/renditions/${rendition.id}/local-generation`,
      `/api/v1/renditions/${rendition.id}/candidates`, `/api/v1/candidates/${candidateId}/accept`, `/api/v1/candidates/${candidateId}/reject`,
      `/api/v1/contents/${content.id}/messages`, `/api/v1/contents/${content.id}/plan/confirm`, `/api/v1/contents/${content.id}/evidence/select`,
      `/api/v1/contents/${content.id}/derive`, `/api/v1/contents/${content.id}/transcribe`, `/api/v1/generation-inputs/${randomUUID()}/generate`,
    ];
    for (const path of paths) expect((await app.rawJson("POST", path, {})).status, path).toBe(404);
    const db = app.context.database.db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM revisions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM authoring_confirmations").get()).toEqual({ n: 0 });
    for (const path of [`/api/v1/contents/${content.id}`, `/api/v1/renditions/${rendition.id}/revisions`, "/api/v1/settings/providers"]) {
      expect((await fetch(`${app.base}${path}`, { headers: { cookie: app.cookie } })).status, path).toBe(200);
    }
    const composition = await fetch(`${app.base}/api/v1/compositions/${content.id}`, { headers: { cookie: app.cookie } });
    expect(composition.status).toBe(404);
    expect(JSON.stringify(await composition.json())).toContain("COMPOSITION_NOT_FOUND");
  } finally { await app.close(); await rm(app.config.dataRoot, { recursive: true, force: true }); }
});
