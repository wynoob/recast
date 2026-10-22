import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ErrorCode,
  HostToWorkerMessage,
  JobGrant,
  WorkerToHostMessage,
} from "@dmall/contracts";
import { ErrorCodeSchema, JobIdSchema, WorkerToHostMessageSchema } from "@dmall/contracts";

export interface WorkerMessageHandler {
  (message: WorkerToHostMessage): Promise<{ accepted: boolean; code: ErrorCode | null }>;
}

interface WorkerHandle {
  child: ChildProcess;
  ready: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  activeJobId: string | null;
  activeDispatchResolve: (() => void) | null;
}

export class WorkerPool {
  private readonly size: number;
  private readonly entry: string;
  private readonly workers: WorkerHandle[] = [];
  private messageHandler: WorkerMessageHandler | null = null;
  private onWorkerExit: ((jobId: string) => void) | null = null;
  private closing = false;

  constructor(input: { size: number; entry?: string }) {
    this.size = input.size;
    this.entry =
      input.entry ??
      process.env.DCW_WORKER_ENTRY ??
      defaultWorkerEntry();
  }

  setMessageHandler(handler: WorkerMessageHandler): void {
    this.messageHandler = handler;
  }

  setWorkerExitHandler(handler: (jobId: string) => void): void {
    this.onWorkerExit = handler;
  }

  async start(): Promise<void> {
    for (let index = 0; index < this.size; index += 1) {
      this.workers.push(this.spawn());
    }
    await Promise.all(this.workers.map((worker) => worker.readyPromise));
  }

  readyCount(): number {
    return this.workers.filter((worker) => worker.ready).length;
  }

  idleWorker(): boolean {
    return this.workers.some(
      (worker) => worker.ready && worker.child.connected && worker.activeJobId === null,
    );
  }

  async dispatch(grant: JobGrant): Promise<void> {
    const worker = this.workers.find(
      (candidate) => candidate.ready && candidate.child.connected && candidate.activeJobId === null,
    );
    if (worker === undefined) throw new Error("没有可用的 worker");
    worker.activeJobId = grant.jobId;
    const dispatchDone = new Promise<void>((resolve) => {
      worker.activeDispatchResolve = resolve;
    });
    if (!sendToWorker(worker, {
      schemaVersion: 1,
      type: "grant",
      grant,
    })) {
      worker.activeJobId = null;
      worker.activeDispatchResolve = null;
      throw new Error("worker IPC 已关闭");
    }
    await dispatchDone;
  }

  cancel(jobId: string, generation: number): void {
    const worker = this.workers.find((candidate) => candidate.activeJobId === jobId);
    if (worker === undefined) return;
    sendToWorker(worker, {
      schemaVersion: 1,
      type: "cancel",
      jobId: JobIdSchema.parse(jobId),
      generation,
    });
  }

  permit(jobId: string, message: import("@dmall/contracts").HostToWorkerMessage & { type: "call_permit" }): boolean {
    const worker = this.workers.find((candidate) => candidate.activeJobId === jobId);
    if (worker === undefined || !worker.child.connected) return false;
    return sendToWorker(worker, message);
  }

  async terminate(jobId: string): Promise<void> {
    const worker = this.workers.find((candidate) => candidate.activeJobId === jobId);
    if (worker === undefined) return;
    worker.ready = false;
    worker.child.kill("SIGKILL");
    await waitForExit(worker.child, 2_000);
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      throw new Error("旧 worker 尚未退出，不能重新分配任务");
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const exits = this.workers.map(async (worker) => {
      if (worker.child.connected) {
        sendToWorker(worker, { schemaVersion: 1, type: "shutdown" });
      }
      await waitForExit(worker.child, 2_000);
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGTERM");
        await waitForExit(worker.child, 1_000);
      }
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
        await waitForExit(worker.child, 2_000);
        if (worker.child.exitCode === null && worker.child.signalCode === null) throw new Error("worker 未退出");
      }
    });
    await Promise.all(exits);
    this.workers.length = 0;
  }

  private spawn(): WorkerHandle {
    const child = fork(this.entry, [], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.on("error", () => undefined);
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker: WorkerHandle = {
      child,
      ready: false,
      readyPromise,
      resolveReady,
      rejectReady,
      activeJobId: null,
      activeDispatchResolve: null,
    };

    child.on("message", (raw: unknown) => {
      const parsed = WorkerToHostMessageSchema.safeParse(raw);
      if (!parsed.success) {
        return;
      }
      const message = parsed.data;
      if (message.type === "ready") {
        worker.ready = true;
        worker.resolveReady();
        return;
      }
      if (message.type === "finished") {
        void this.handleMessage(worker, message).finally(() => {
          if (worker.activeJobId !== message.fence.jobId) return;
          worker.activeJobId = null;
          const resolve = worker.activeDispatchResolve;
          worker.activeDispatchResolve = null;
          resolve?.();
        });
        return;
      }
      if (message.type === "waiting") {
        void this.handleMessage(worker, message).finally(() => {
          if (worker.activeJobId !== message.fence.jobId) return;
          worker.activeJobId = null;
          const resolve = worker.activeDispatchResolve;
          worker.activeDispatchResolve = null;
          resolve?.();
        });
        return;
      }
      void this.handleMessage(worker, message);
    });

    child.on("exit", (code, signal) => {
      worker.ready = false;
      if (!worker.ready) worker.rejectReady(new Error(`worker exited: ${code ?? signal ?? "unknown"}`));
      if (worker.activeJobId !== null) {
        const jobId = worker.activeJobId;
        worker.activeJobId = null;
        const resolve = worker.activeDispatchResolve;
        worker.activeDispatchResolve = null;
        if (resolve !== null) resolve();
        this.onWorkerExit?.(jobId);
      }
      if (!this.closing) {
        const index = this.workers.indexOf(worker);
        if (index >= 0) {
          this.workers.splice(index, 1);
          const replacement = this.spawn();
          this.workers.push(replacement);
          void replacement.readyPromise.catch(() => undefined);
        }
      }
    });
    return worker;
  }

  private async handleMessage(worker: WorkerHandle, message: WorkerToHostMessage): Promise<void> {
    if (this.messageHandler === null) return;
    try {
      const result = await this.messageHandler(message);
      if (message.type !== "ready" && worker.child.connected) {
        sendToWorker(worker, {
          schemaVersion: 1,
          type: "ack",
          messageId: message.messageId,
          accepted: result.accepted,
          code: result.code,
        });
      }
    } catch (error) {
      process.stderr.write(
        `worker message handling failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      if (message.type !== "ready" && worker.child.connected) {
        sendToWorker(worker, {
          schemaVersion: 1,
          type: "ack",
          messageId: message.messageId,
          accepted: false,
          code: errorCodeOf(error),
        });
      }
    }
  }
}

function defaultWorkerEntry(): string {
  const besideServer = fileURLToPath(new URL("../worker/main.js", import.meta.url));
  if (existsSync(besideServer)) return besideServer;
  const built = join(process.cwd(), "dist", "apps", "worker", "main.js");
  if (existsSync(built)) return built;
  return besideServer;
}

function errorCodeOf(error: unknown): ErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = ErrorCodeSchema.safeParse(error.code);
    if (parsed.success) return parsed.data;
  }
  return "INTERNAL_ERROR";
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sendToWorker(worker: WorkerHandle, message: HostToWorkerMessage): boolean {
  if (!worker.child.connected) return false;
  try {
    worker.child.send(message, () => undefined);
    return true;
  } catch {
    return false;
  }
}
