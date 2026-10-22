import { createHash } from "node:crypto";
import type { JobResult } from "@dmall/contracts";
import type { ImportRepository } from "./import-repository.js";
import type { JobRepository } from "./job-repository.js";
type State = "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled";
export class ImportLifecycle {
  constructor(private readonly imports: ImportRepository, private readonly jobs: JobRepository) { }
  finalize(id: string, state: State, result: JobResult | null): {
    state: State;
    result: JobResult | null;
  } {
    const row = this.jobs.get(id);
    if (row === null)
      return { state, result };
    if (state === "waiting_input") return { state, result };
    if (row.input.jobType === "local_scan") {
      const scan = this.imports.requireScan(row.input.scanId);
      if (state === "queued") {
        this.imports.setScanStatus(scan.id, "queued");
        return { state, result: null };
      }
      this.imports.finalizeScan(scan.id, { status: state === "succeeded" ? "ready" : state === "cancelled" ? "cancelled" : "failed",
        manifestHash: scan.manifestHash ?? createHash("sha256").update(this.imports.scanItems(scan.id, { limit: 100000, offset: 0 }).items.map(item => `${item.relativePath}:${item.bytes}:${item.mtimeMs}`).sort().join("\n")).digest("hex") });
      const updated = this.imports.requireScan(scan.id);
      return { state, result: { schemaVersion: 1, jobType: "local_scan", scanId: scan.id, counts: updated.counts, manifestHash: updated.manifestHash ?? createHash("sha256").digest("hex") } };
    }
    if (row.input.jobType !== "local_import" || state === "queued")
      return { state, result };
    this.imports.failOpenImportItems(id, state === "cancelled" ? "skipped" : "failed", state === "cancelled" ? "JOB_CANCELLED" : "INTERNAL_ERROR", state === "cancelled" ? "任务取消，未处理项目保留记录" : "任务结束但项目没有提交结果");
    const counts = this.imports.importCounts(id);
    const mappingFailure =
      row.input.assetMap?.sourceScanItemIds.some((sourceScanItemId) => {
        const item = this.imports.importItemByScanItem(id, sourceScanItemId);
        if (item === null) return true;
        if (item.state === "failed" || item.state === "skipped") return true;
        if (item.state !== "committed") return true;
        return item.result.mapping?.status !== "applied";
      }) ?? false;
    const finalState =
      state === "cancelled"
        ? state
        : this.imports.hasPartialDocuments(id) || counts.failed + counts.skipped > 0 || mappingFailure
          ? counts.committed > 0
            ? "partial"
            : "failed"
          : counts.committed > 0
            ? "succeeded"
            : "failed";
    return { state: finalState, result: { schemaVersion: 1, jobType: "local_import", importId: id, committed: counts.committed, failed: counts.failed, skipped: counts.skipped, assetIds: this.imports.committedAssetIds(id) } };
  }
}
