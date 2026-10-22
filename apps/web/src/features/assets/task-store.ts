import { useSyncExternalStore } from "react";
import { z } from "zod";

const TaskRecordSchema = z.strictObject({
  jobId: z.uuid(),
  kind: z.enum(["scan", "import"]),
  scanId: z.uuid().nullable(),
  importId: z.uuid().nullable(),
  label: z.string().min(1).max(300),
  createdAt: z.string(),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

const STORAGE_KEY = "dcw.tasks.v1";
const CHANGE_EVENT = "dcw-tasks-change";
const EMPTY: TaskRecord[] = [];

let cached: TaskRecord[] | null = null;

function read(): TaskRecord[] {
  if (cached !== null) return cached;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return (cached = EMPTY);
    const parsed = z.array(TaskRecordSchema).safeParse(JSON.parse(raw));
    cached = parsed.success ? parsed.data : EMPTY;
    return cached;
  } catch {
    cached = EMPTY;
    return cached;
  }
}

function write(next: TaskRecord[]): void {
  cached = next;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable in private windows. The in-memory list still works.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTaskRecords(): TaskRecord[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function addTask(record: TaskRecord): void {
  const current = read();
  if (current.some((item) => item.jobId === record.jobId)) return;
  write([record, ...current].slice(0, 50));
}

export function removeTask(jobId: string): void {
  const current = read();
  if (!current.some((item) => item.jobId === jobId)) return;
  write(current.filter((item) => item.jobId !== jobId));
}

export function clearTasks(): void {
  write([]);
}
