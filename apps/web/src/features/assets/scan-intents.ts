import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { ScanCreateRequestSchema, type ScanCreateRequest } from "@dmall/contracts";
import { ApiClientError } from "../../api.js";
import { cancelJob, createScan } from "./api.js";

const common = {
  key: z.uuid(), label: z.string(), createdAt: z.string(), message: z.string().nullable(),
};
const IntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("creating"), request: ScanCreateRequestSchema }),
  z.strictObject({ ...common, kind: z.literal("cancel_create"), request: ScanCreateRequestSchema }),
  z.strictObject({ ...common, kind: z.literal("cancel_job"), jobId: z.uuid(), scanId: z.uuid() }),
]);
type ScanIntent = z.infer<typeof IntentSchema>;
type CreatedScan = Awaited<ReturnType<typeof createScan>>;
const STORAGE = "dcw.scan-intents.v1";
const CHANGE = "dcw-scan-intents-change";
const EMPTY: ScanIntent[] = [];
let cache: ScanIntent[] | null = null;
const running = new Map<string, Promise<CreatedScan | null>>();

function read(): ScanIntent[] {
  if (cache !== null) return cache;
  try {
    const parsed = z.array(IntentSchema).safeParse(JSON.parse(localStorage.getItem(STORAGE) ?? "[]"));
    return (cache = parsed.success ? parsed.data : EMPTY);
  } catch { return (cache = EMPTY); }
}
function put(intent: ScanIntent): void {
  write([...read().filter((item) => item.key !== intent.key), intent]);
}
function remove(key: string): void { write(read().filter((item) => item.key !== key)); }
function write(intents: ScanIntent[]): void {
  cache = intents;
  try { localStorage.setItem(STORAGE, JSON.stringify(intents)); } catch { }
  window.dispatchEvent(new Event(CHANGE));
}
function subscribe(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === STORAGE) { cache = null; listener(); } };
  window.addEventListener(CHANGE, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(CHANGE, listener); window.removeEventListener("storage", storage); };
}
export function useScanIntents() { return useSyncExternalStore(subscribe, read, () => EMPTY); }

export function newScanIntent(request: ScanCreateRequest, label: string): string {
  const key = crypto.randomUUID();
  put({ kind: "creating", request, label, key, createdAt: new Date().toISOString(), message: null });
  return key;
}

export function runScanIntent(key: string, csrfToken: string): Promise<CreatedScan | null> {
  const active = running.get(key);
  if (active !== undefined) return active;
  const execute = async (): Promise<CreatedScan | null> => {
    let intent = read().find((item) => item.key === key);
    if (intent === undefined) return null;
    try {
      if (intent.kind !== "cancel_job") {
        const created = await createScan({ request: intent.request, csrfToken, idempotencyKey: key });
        const latest = read().find((item) => item.key === key);
        if (latest?.kind === "creating") { remove(key); return created; }
        intent = { kind: "cancel_job", key, label: intent.label, createdAt: intent.createdAt, message: null, jobId: created.jobId, scanId: created.scanId };
        put(intent);
      }
      await cancelJob({ jobId: intent.jobId, csrfToken });
      remove(key);
      return null;
    } catch (reason) {
      const latest = read().find((item) => item.key === key);
      if (latest !== undefined) {
        if (latest.kind === "cancel_create" && reason instanceof ApiClientError && reason.status >= 400 && reason.status < 500) remove(key);
        else put({ ...latest, message: reason instanceof Error ? reason.message : "扫描结果尚未确认" });
      }
      throw reason;
    }
  };
  const promise = execute().finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}

export function cancelScanIntent(key: string, csrfToken: string): Promise<CreatedScan | null> {
  const intent = read().find((item) => item.key === key);
  if (intent === undefined) return Promise.resolve(null);
  if (intent.kind === "creating") put({ ...intent, kind: "cancel_create", message: null });
  return runScanIntent(key, csrfToken);
}

export function useScanIntentRecovery(csrfToken: string | undefined): void {
  useEffect(() => {
    if (csrfToken === undefined) return;
    for (const intent of read()) {
      if (!running.has(intent.key)) void cancelScanIntent(intent.key, csrfToken).catch(() => undefined);
    }
  }, [csrfToken]);
}

export function cancelCreatedScan(key: string, created: CreatedScan, label: string, csrfToken: string): Promise<CreatedScan | null> {
  put({ kind: "cancel_job", key, jobId: created.jobId, scanId: created.scanId, label, createdAt: new Date().toISOString(), message: null });
  return runScanIntent(key, csrfToken);
}
