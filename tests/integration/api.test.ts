import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CreateContentRequestSchema } from "@dmall/contracts";
import { ContentRepository } from "../../apps/server/src/content-repository.js";
import { IdempotencyRepository } from "../../apps/server/src/idempotency.js";
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
  it("retires blank creation while listing and reopening historical content", async () => {
    const { context } = await testApp();
    try {
      const auth = await session(context.app);
      const headers = { host: "127.0.0.1:4318", cookie: auth.cookie };
      const empty = await context.app.inject({ method: "GET", url: "/api/v1/contents", headers });
      expect(JSON.parse(empty.body).data.total).toBe(0);
      const body = CreateContentRequestSchema.parse({ schemaVersion: 1, title: "历史内容", kind: "feishu_doc" });
      const retired = await context.app.inject({ method: "POST", url: "/api/v1/contents",
        headers: { ...headers, "x-csrf-token": auth.csrfToken, "idempotency-key": randomUUID() }, payload: body });
      expect(retired.statusCode).toBe(404);
      expect(context.database.db.prepare("SELECT COUNT(*) AS n FROM contents").get()).toEqual({ n: 0 });
      const idempotency = new IdempotencyRepository(context.database.db);
      const repository = new ContentRepository(context.database.db, idempotency);
      const historical = repository.create(body, { routeScope: "historical-fixture", key: randomUUID(),
        requestHash: idempotency.requestHash(body), requestId: randomUUID() });
      const list = await context.app.inject({ method: "GET", url: "/api/v1/contents", headers });
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).data).toMatchObject({ total: 1, items: [{ title: "历史内容" }] });
      const detail = await context.app.inject({ method: "GET", url: `/api/v1/contents/${historical.id}`, headers });
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body).data.id).toBe(historical.id);
    } finally { await context.app.close(); }
  });

  it("replays Composer submissions and rejects a different body under the same key", async () => {
    const { context } = await testApp();
    try {
      const stamp = new Date().toISOString();
      context.database.db.prepare(`INSERT INTO provider_configs
        (id, role, base_url, model_id, capabilities_json, keychain_ref, created_at, updated_at)
        VALUES (?, 'text', 'http://127.0.0.1:1/v1', 'boundary-fixture', '{"verified":true}', 'BOUNDARY_TEST_KEY', ?, ?)`)
        .run(randomUUID(), stamp, stamp);
      const auth = await session(context.app);
      const headers = { host: "127.0.0.1:4318", cookie: auth.cookie,
        "x-csrf-token": auth.csrfToken, "idempotency-key": randomUUID() };
      const payload = { mode: "create", idea: "幂等创作", delivery: { kind: "html_deck" } };
      const first = await context.app.inject({ method: "POST", url: "/api/v1/compositions/submit", headers, payload });
      expect(first.statusCode).toBe(202);
      const replay = await context.app.inject({ method: "POST", url: "/api/v1/compositions/submit", headers, payload });
      expect(replay.body).toBe(first.body);
      const conflict = await context.app.inject({ method: "POST", url: "/api/v1/compositions/submit", headers,
        payload: { ...payload, idea: "不同创作" } });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(context.database.db.prepare("SELECT COUNT(*) AS n FROM contents").get()).toEqual({ n: 1 });
    } finally { await context.app.close(); }
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
      const body = { mode: "create", idea: "测试", delivery: { kind: "html_deck" } };
      const noCsrf = await context.app.inject({
        method: "POST",
        url: "/api/v1/compositions/submit",
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
        url: "/api/v1/compositions/submit",
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
        url: "/api/v1/compositions/submit",
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
