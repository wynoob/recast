import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppContext } from "../../apps/server/src/app.js";
import type { RuntimeConfig } from "../../apps/server/src/config.js";

export interface T02cTestApp {
  readonly context: AppContext;
  readonly config: RuntimeConfig;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  getJson(path: string): Promise<unknown>;
  writeJson(
    method: string,
    path: string,
    body: unknown,
    key?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown>;
  rawJson(
    method: string,
    path: string,
    body: unknown,
    key?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export async function startT02cApp(existingDataRoot?: string): Promise<T02cTestApp> {
  const port = await freePort();
  const dataRoot = existingDataRoot ?? (await mkdtemp(join(tmpdir(), "dcw-t02c-data-")));
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port,
    dataRoot,
    dbPath: join(dataRoot, "db", "workbench.sqlite"),
    backupDir: join(dataRoot, "backups"),
    webRoot: join(dataRoot, "no-web"),
    workerPoolSize: 1,
    devOrigins: [],
  };
  const context = await createApp({ config, startWorkers: false });
  await context.app.listen({ host: "127.0.0.1", port });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/v1/health`);
  const setCookie = health.headers.get("set-cookie");
  if (setCookie === null) throw new Error("missing session cookie");
  const cookie = setCookie.split(";")[0] ?? "";
  const healthBody = (await health.json()) as { data: { csrfToken: string } };
  const csrf = healthBody.data.csrfToken;

  const rawJson = async (
    method: string,
    path: string,
    body: unknown,
    key = randomUUID(),
    extraHeaders: Record<string, string> = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "Idempotency-Key": key,
        "content-type": "application/json",
        origin: base,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };

  return {
    context,
    config,
    base,
    cookie,
    csrf,
    async getJson(path: string): Promise<unknown> {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      return await response.json();
    },
    async writeJson(
      method: string,
      path: string,
      body: unknown,
      key = randomUUID(),
      extraHeaders: Record<string, string> = {},
    ): Promise<unknown> {
      const response = await rawJson(method, path, body, key, extraHeaders);
      if (response.status >= 400) {
        throw new Error(`${method} ${path} failed ${response.status}: ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
    rawJson,
    async close(): Promise<void> {
      await context.app.close();
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
