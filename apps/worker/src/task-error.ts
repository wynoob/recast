import type { ErrorCode } from "@dmall/contracts";

export class WorkerTaskError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WorkerTaskError";
    this.code = code;
    this.retryable = retryable;
  }
}
