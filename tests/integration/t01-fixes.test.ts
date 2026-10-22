import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@dmall/storage";
import { JobRepository } from "../../apps/server/src/job-repository.js";

async function withRepository(run: (jobs: JobRepository, db: Awaited<ReturnType<typeof openDatabase>>["db"]) => void) {
  const root = await mkdtemp(join(tmpdir(), "dcw-t01-fix-"));
  const { db } = await openDatabase({ dbPath: join(root, "db.sqlite") });
  try { run(new JobRepository(db), db); }
  finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

const create = (jobs: JobRepository) => jobs.create({
  type: "fixture_long", input: { schemaVersion: 1, jobType: "fixture_long", steps: 3, stepMs: 20 },
  inputHash: "a".repeat(64), idempotencyKey: null,
});

describe("T01 recovery and atomic transitions", () => {
  it("cancellation wins over worker exit and retry exhaustion", async () => {
    await withRepository((jobs, db) => {
      const job = create(jobs);
      const { grant } = jobs.assign(job.id, "owner");
      jobs.requestCancel(job.id, grant.fence.leaseGeneration);
      db.prepare("UPDATE jobs SET attempt = max_attempts WHERE id = ?").run(job.id);
      jobs.requeueAfterWorkerExit(job.id);
      expect(jobs.snapshotById(job.id).state).toBe("cancelled");
      expect(jobs.events(job.id, 0).at(-1)?.payload).toMatchObject({ kind: "completed", state: "cancelled" });
      expect(jobs.requeueAfterWorkerExit(job.id)).toBeNull();
    });
  });

  it("exhausted jobs fail with a durable error and leave the queue runnable", async () => {
    await withRepository((jobs) => {
      const job = create(jobs);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        jobs.assign(job.id, "owner"); jobs.requeueAfterWorkerExit(job.id);
      }
      const next = create(jobs);
      expect(jobs.snapshotById(job.id)).toMatchObject({ state: "failed", error: { retryable: false } });
      expect(jobs.events(job.id, 0).at(-1)?.kind).toBe("error");
      expect(jobs.nextQueued(1)[0]?.snapshot.id).toBe(next.id);
    });
  });

  it("restart settles old queued cancellations and exhausted rows", async () => {
    await withRepository((jobs, db) => {
      const cancelled = create(jobs); const exhausted = create(jobs);
      db.prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?").run(cancelled.id);
      db.prepare("UPDATE jobs SET attempt=max_attempts WHERE id=?").run(exhausted.id);
      jobs.recoverInterrupted();
      expect(jobs.snapshotById(cancelled.id).state).toBe("cancelled");
      expect(jobs.snapshotById(exhausted.id).state).toBe("failed");
    });
  });

  it("finish rolls state and result back if the durable event fails", async () => {
    await withRepository((jobs, db) => {
      const job = create(jobs); const { grant } = jobs.assign(job.id, "owner");
      const before = jobs.snapshotById(job.id);
      db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON job_events WHEN NEW.kind='completed' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
      expect(() => jobs.finish({ fence: grant.fence, state: "succeeded", result: {
        schemaVersion: 1, jobType: "fixture_long", completedSteps: 3, digest: "b".repeat(64),
      }, error: null })).toThrow("injected event failure");
      expect(jobs.snapshotById(job.id)).toEqual(before);
      expect(jobs.events(job.id, 0)).toHaveLength(1);
    });
  });

  it("resume rolls back when the caller receipt fails, then succeeds once", async () => {
    await withRepository((jobs, db) => {
      const job = create(jobs);
      db.prepare("UPDATE jobs SET state='waiting_input' WHERE id=?").run(job.id);
      const before = jobs.snapshotById(job.id);
      db.exec("CREATE TABLE receipt(id TEXT); CREATE TRIGGER reject_receipt BEFORE INSERT ON receipt BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
      expect(() => jobs.resume(job.id, () => db.prepare("INSERT INTO receipt VALUES (?)").run(job.id))).toThrow("injected receipt failure");
      expect(jobs.snapshotById(job.id)).toEqual(before);
      expect(jobs.events(job.id, 0)).toHaveLength(1);
      db.exec("DROP TRIGGER reject_receipt");
      const resumed = jobs.resume(job.id, () => db.prepare("INSERT INTO receipt VALUES (?)").run(job.id));
      expect(resumed.snapshot.state).toBe("queued");
      expect(resumed.event.seq).toBe(2);
      expect(db.prepare("SELECT * FROM receipt").all()).toHaveLength(1);
    });
  });
});
