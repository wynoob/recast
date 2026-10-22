import { createApp, type AppContext } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
let context: AppContext | null = null;

async function start(): Promise<void> {
  context = await createApp({ config });
  await context.app.listen({ host: config.host, port: config.port });
  context.app.log.info({ host: config.host, port: config.port }, "Dmall content workbench started");
}

async function shutdown(): Promise<void> {
  if (context === null) return;
  const current = context;
  context = null;
  await current.app.close();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

start().catch(async (error: unknown) => {
  if (context !== null) {
    await context.app.close().catch(() => undefined);
    context = null;
  }
  const message =
    isErrno(error, "EADDRINUSE")
      ? `端口 ${config.port} 已被占用，请先停止已有工作台或设置 DCW_PORT`
      : error instanceof Error
        ? error.message
        : "启动失败";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
