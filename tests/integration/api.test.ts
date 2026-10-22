import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";

const roots: string[] = [];

async function testApp() {
  const dataRoot = await mkdtemp(join(tmpdir(), "dcw-api-"));
  roots.push(dataRoot);
  const config = loadConfig();
  const context = await createApp({
    startWorkers: false,
    config: {
      ...config,
      dataRoot,
      dbPath: join(dataRoot, "db", "workbench.sqlite"),
      backupDir: join(dataRoot, "backups"),
      webRoot: join(dataRoot, "web"),
    },
  });
  return { context, dataRoot };
}

async function session(app: Awaited<ReturnType<typeof testApp>>["context"]["app"]) {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { host: "127.0.0.1:4318" },
  });
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body) as { data: { csrfToken: string } };
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (raw === undefined) throw new Error("session cookie missing");
  return { cookie: raw.split(";")[0] ?? "", csrfToken: body.data.csrfToken };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local API boundaries", () => {
  it("creates, lists and reopens a blank content without a model", async () => {
    const { context } = await testApp();
    try {
      const auth = await session(context.app);
      const empty = await context.app.inject({
        method: "GET",
        url: "/api/v1/contents",
        headers: { host: "127.0.0.1:4318", cookie: auth.cookie },
      });
      expect((JSON.parse(empty.body) as { data: { total: number } }).data.total).toBe(0);
      const body = {
        schemaVersion: 1,
        title: "空库第一份内容",
        kind: "feishu_doc",
      };
      const created = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers: {
          host: "127.0.0.1:4318",
          cookie: auth.cookie,
          "x-csrf-token": auth.csrfToken,
          "idempotency-key": randomUUID(),
        },
        payload: body,
      });
      expect(created.statusCode).toBe(201);
      const createdBody = JSON.parse(created.body) as {
        data: { id: string; renditions: Array<{ currentRevisionId: string; revision: { ast: { sections: unknown[] } } }> };
      };
      expect(createdBody.data.renditions).toHaveLength(1);
      expect(createdBody.data.renditions[0]?.revision.ast.sections).toEqual([]);

      const list = await context.app.inject({
        method: "GET",
        url: "/api/v1/contents",
        headers: { host: "127.0.0.1:4318" },
      });
      expect(list.statusCode).toBe(200);
      const listBody = JSON.parse(list.body) as { data: { total: number; items: Array<{ title: string }> } };
      expect(listBody.data.total).toBe(1);
      expect(listBody.data.items[0]?.title).toBe("空库第一份内容");

      const detail = await context.app.inject({
        method: "GET",
        url: `/api/v1/contents/${createdBody.data.id}`,
        headers: { host: "127.0.0.1:4318" },
      });
      expect(detail.statusCode).toBe(200);
    } finally {
      await context.app.close();
    }
  });

  it("replays the same key and rejects a different body", async () => {
    const { context } = await testApp();
    try {
      const auth = await session(context.app);
      const key = randomUUID();
      const headers = {
        host: "127.0.0.1:4318",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrfToken,
        "idempotency-key": key,
      };
      const first = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers,
        payload: { schemaVersion: 1, title: "幂等内容", kind: "html_deck" },
      });
      const replay = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers,
        payload: { schemaVersion: 1, title: "幂等内容", kind: "html_deck" },
      });
      expect(first.statusCode).toBe(201);
      expect(replay.body).toBe(first.body);
      const conflict = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers,
        payload: { schemaVersion: 1, title: "不同内容", kind: "html_deck" },
      });
      expect(conflict.statusCode).toBe(409);
      expect((JSON.parse(conflict.body) as { error: { code: string } }).error.code).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
    } finally {
      await context.app.close();
    }
  });

  it("rejects foreign Host, missing CSRF and missing idempotency keys", async () => {
    const { context } = await testApp();
    try {
      const foreign = await context.app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: { host: "evil.example:4318" },
      });
      expect(foreign.statusCode).toBe(403);

      const auth = await session(context.app);
      const body = { schemaVersion: 1, title: "测试", kind: "feishu_doc" };
      const noCsrf = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers: {
          host: "127.0.0.1:4318",
          cookie: auth.cookie,
          "idempotency-key": randomUUID(),
        },
        payload: body,
      });
      expect(noCsrf.statusCode).toBe(403);

      const noKey = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers: {
          host: "127.0.0.1:4318",
          cookie: auth.cookie,
          "x-csrf-token": auth.csrfToken,
        },
        payload: body,
      });
      expect(noKey.statusCode).toBe(400);

      const badOrigin = await context.app.inject({
        method: "POST",
        url: "/api/v1/contents",
        headers: {
          host: "127.0.0.1:4318",
          origin: "http://evil.example:4318",
          cookie: auth.cookie,
          "x-csrf-token": auth.csrfToken,
          "idempotency-key": randomUUID(),
        },
        payload: body,
      });
      expect(badOrigin.statusCode).toBe(403);
    } finally {
      await context.app.close();
    }
  });
});
