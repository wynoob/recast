import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimeConfig {
  host: "127.0.0.1";
  port: number;
  dataRoot: string;
  dbPath: string;
  backupDir: string;
  webRoot: string;
  workerPoolSize: number;
  devOrigins: readonly string[];
}

export function loadConfig(): RuntimeConfig {
  const dataRoot = resolve(
    process.env.DCW_DATA_ROOT ??
      join(homedir(), "Library", "Application Support", "DmallContentWorkbench"),
  );
  const port = parsePort(process.env.DCW_PORT ?? "4318");
  return {
    host: "127.0.0.1",
    port,
    dataRoot,
    dbPath: join(dataRoot, "db", "workbench.sqlite"),
    backupDir: join(dataRoot, "backups"),
    webRoot: resolve(process.env.DCW_WEB_ROOT ?? join(process.cwd(), "dist", "web")),
    workerPoolSize: parsePoolSize(process.env.DCW_WORKER_POOL_SIZE ?? "2"),
    devOrigins: [`http://127.0.0.1:5173`, `http://localhost:5173`],
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`无效端口: ${value}`);
  }
  return port;
}

function parsePoolSize(value: string): number {
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > 8) {
    throw new Error(`无效 worker 数量: ${value}`);
  }
  return size;
}
