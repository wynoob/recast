import type { AuthoringOperation } from "@dmall/contracts";

export type SaveStatus = "saved" | "dirty" | "saving" | "conflict" | "error";

export interface SaveSnapshot<T> {
  renditionId: string;
  baseRevisionId: string;
  value: T;
  operations: AuthoringOperation[];
  claims: import("@dmall/contracts").Claim[];
  evidenceSelections: string[];
}

export interface SaveResult<T> {
  revisionId: string;
  value: T;
}

interface QueueState<T> {
  current: SaveSnapshot<T> | null;
  pending: SaveSnapshot<T> | null;
  running: boolean;
  generation: number;
  settled: Promise<void>;
}

export class RenditionSaveQueues<T> {
  private readonly states = new Map<string, QueueState<T>>();

  enqueue(input: {
    snapshot: SaveSnapshot<T>;
    send: (snapshot: SaveSnapshot<T>) => Promise<SaveResult<T>>;
    onSaved: (result: SaveResult<T>, latest: boolean) => void;
    onError: (error: unknown, snapshot: SaveSnapshot<T>) => void;
  }): void {
    const state = this.state(input.snapshot.renditionId);
    if (state.running) {
      state.pending = input.snapshot;
      return;
    }
    state.running = true;
    state.current = input.snapshot;
    state.settled = this.drain(state, input);
  }

  async whenIdle(renditionId: string): Promise<void> {
    await this.states.get(renditionId)?.settled;
  }

  hasPending(renditionId: string): boolean {
    const state = this.states.get(renditionId);
    return state !== undefined && (state.running || state.pending !== null);
  }

  reset(renditionId: string): void {
    this.states.delete(renditionId);
  }

  private async drain(
    state: QueueState<T>,
    handlers: {
      send: (snapshot: SaveSnapshot<T>) => Promise<SaveResult<T>>;
      onSaved: (result: SaveResult<T>, latest: boolean) => void;
      onError: (error: unknown, snapshot: SaveSnapshot<T>) => void;
    },
  ): Promise<void> {
    let snapshot = state.current;
    while (snapshot !== null) {
      const generation = ++state.generation;
      try {
        const result = await handlers.send(snapshot);
        const latest = state.pending === null;
        handlers.onSaved(result, latest);
      } catch (error) {
        state.running = false;
        state.current = null;
        state.pending = null;
        handlers.onError(error, snapshot);
        return;
      }
      if (state.generation !== generation) {
        state.running = false;
        return;
      }
      snapshot = state.pending;
      state.pending = null;
      state.current = snapshot;
    }
    state.running = false;
    state.current = null;
  }

  private state(renditionId: string): QueueState<T> {
    const existing = this.states.get(renditionId);
    if (existing !== undefined) return existing;
    const created: QueueState<T> = {
      current: null,
      pending: null,
      running: false,
      generation: 0,
      settled: Promise.resolve(),
    };
    this.states.set(renditionId, created);
    return created;
  }
}

export const SAVE_DEBOUNCE_MS = 800;

export function pendingStorageKey(renditionId: string): string {
  return `dcw.authoring.pending.${renditionId}`;
}

export function readPending<T>(renditionId: string): { baseRevisionId: string; value: T; savedAt: string } | null {
  try {
    const raw = localStorage.getItem(pendingStorageKey(renditionId));
    return raw === null ? null : JSON.parse(raw) as { baseRevisionId: string; value: T; savedAt: string };
  } catch {
    return null;
  }
}

export function writePending<T>(renditionId: string, baseRevisionId: string, value: T): void {
  localStorage.setItem(pendingStorageKey(renditionId), JSON.stringify({
    baseRevisionId,
    value,
    savedAt: new Date().toISOString(),
  }));
}

export function clearPending(renditionId: string): void {
  localStorage.removeItem(pendingStorageKey(renditionId));
}
