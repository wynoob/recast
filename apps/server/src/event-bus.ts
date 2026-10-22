import { EventEmitter } from "node:events";
import type { JobEvent } from "@dmall/contracts";

export class JobEventBus {
  private readonly emitter = new EventEmitter();

  publish(event: JobEvent): void {
    this.emitter.emit(event.jobId, event);
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}
