import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkerTaskError } from "./task-error.js";

const SUPERVISOR_ENTRY = fileURLToPath(new URL("./media-supervisor.js", import.meta.url));
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export interface SupervisedRunResult {
  stdout: string;
  stderr: string;
}

export class MediaProcessRuntime {
  private readonly active = new Set<{ supervisor: ChildProcess; terminate: () => void }>();
  private shuttingDown = false;

  async run(input: {
    command: string;
    args: string[];
    signal: AbortSignal;
    timeoutMs?: number;
  }): Promise<SupervisedRunResult> {
    if (this.shuttingDown) throw new WorkerTaskError("JOB_CANCELLED", "worker 正在停止");
    if (input.signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "媒体任务已取消");
    const supervisor = spawn(
      process.execPath,
      [
        SUPERVISOR_ENTRY,
        "--parent-pid",
        String(process.pid),
        "--",
        input.command,
        ...input.args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
      } else if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += chunk.toString("utf8");
      }
    };
    supervisor.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    supervisor.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));

    const terminate = (): void => {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        const force = setTimeout(() => {
          if (supervisor.exitCode === null && supervisor.signalCode === null) {
            supervisor.kill("SIGKILL");
          }
        }, 500);
        force.unref();
      }
    };
    const handle = { supervisor, terminate };
    this.active.add(handle);
    const onAbort = (): void => terminate();
    input.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => terminate(),
      input.timeoutMs ?? 10 * 60 * 1000,
    );
    timeout.unref();

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      supervisor.once("exit", (code, signal) => resolve({ code, signal }));
      supervisor.once("error", () => resolve({ code: null, signal: null }));
    }).finally(() => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      this.active.delete(handle);
    });

    if (input.signal.aborted || this.shuttingDown) {
      throw new WorkerTaskError("JOB_CANCELLED", "媒体任务已取消");
    }
    if (exit.code !== 0) {
      throw new WorkerTaskError(
        "INTERNAL_ERROR",
        `${input.command} 退出码 ${String(exit.code)}: ${stderr.trim().slice(-2_000)}`,
        true,
      );
    }
    return { stdout, stderr };
  }

  async terminateAll(): Promise<void> {
    this.shuttingDown = true;
    const exits = [...this.active].map(
      (handle) =>
        new Promise<void>((resolve) => {
          handle.supervisor.once("exit", () => resolve());
          handle.terminate();
          setTimeout(resolve, 1_000).unref();
        }),
    );
    await Promise.all(exits);
    this.active.clear();
  }

  reset(): void {
    this.shuttingDown = false;
  }
}
