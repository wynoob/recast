import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@dmall/storage";
import { JobRepository } from "../../apps/server/src/job-repository.js";
import { RemoteOperationRepository } from "../../apps/server/src/remote-operations.js";

const roots: string[] = [];

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "dcw-jobs-"));
  roots.push(root);
  const db = await openDatabase({
    dbPath: join(root, "db", "workbench.sqlite"),
    backupDir: join(root, "backups"),
  });
  return { db, jobs: new JobRepository(db.db) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("job leases and remote operation states", () => {
  it("rejects an old generation and keeps the checkpoint recoverable", async () => {
    const { db, jobs } = await repository();
    try {
      const snapshot = jobs.create({
        type: "fixture_long",
        input: { schemaVersion: 1, jobType: "fixture_long", steps: 3, stepMs: 20 },
        inputHash: "a".repeat(64),
        idempotencyKey: null,
      });
      const assigned = jobs.assign(snapshot.id, "owner-1");
      expect(assigned.grant.fence.leaseGeneration).toBe(1);
      expect(jobs.heartbeat(assigned.grant.fence)).toBe(true);
      expect(
        jobs.checkpoint(assigned.grant.fence, {
          schemaVersion: 1,
          jobType: "fixture_long",
          cursor: 1,
          digest: "b".repeat(64),
        }),
      ).toBe(true);
      const stale = { ...assigned.grant.fence, leaseGeneration: 0 };
      expect(jobs.checkpoint(stale, {
        schemaVersion: 1,
        jobType: "fixture_long",
        cursor: 2,
        digest: "c".repeat(64),
      })).toBe(false);
      expect(jobs.finish({
        fence: stale,
        state: "succeeded",
        result: {
          schemaVersion: 1,
          jobType: "fixture_long",
          completedSteps: 3,
          digest: "d".repeat(64),
        },
        error: null,
      })).toBeNull();
      const recovered = jobs.snapshotById(snapshot.id);
      expect(recovered.checkpoint).toMatchObject({ jobType: "fixture_long", cursor: 1 });
    } finally {
      db.db.close();
    }
  });

  it("records prepared, dispatched and unknown remote states", async () => {
    const { db, jobs } = await repository();
    try {
      const snapshot = jobs.create({
        type: "local_env_probe",
        input: { schemaVersion: 1, jobType: "local_env_probe" },
        inputHash: "e".repeat(64),
        idempotencyKey: null,
      });
      const assigned = jobs.assign(snapshot.id, "owner-2");
      const remote = new RemoteOperationRepository(db.db);
      const operation = remote.prepare({
        jobId: snapshot.id,
        attempt: assigned.grant.fence.attempt,
        leaseGeneration: assigned.grant.fence.leaseGeneration,
        kind: "feishu_create_document",
        requestHash: "f".repeat(64),
        remoteClientToken: null,
      });
      expect(operation.state).toBe("prepared");
      expect(
        remote.markDispatched({
          operationId: operation.operationId,
          attempt: operation.attempt,
          leaseGeneration: operation.leaseGeneration,
          requestHash: operation.requestHash,
        }).state,
      ).toBe("dispatched");
      expect(
        remote.markUnknown({
          operationId: operation.operationId,
          attempt: operation.attempt,
          leaseGeneration: operation.leaseGeneration,
        }).state,
      ).toBe("unknown");
    } finally {
      db.db.close();
    }
  });

  it("requeues a waiting_input job and commits the caller result", async () => {
    const { db, jobs } = await repository();
    try {
      const snapshot = jobs.create({
        type: "local_env_probe",
        input: { schemaVersion: 1, jobType: "local_env_probe" },
        inputHash: "a".repeat(64),
        idempotencyKey: null,
      });
      db.db.prepare("UPDATE jobs SET state = 'waiting_input', phase = 'waiting' WHERE id = ?").run(snapshot.id);
      let committed: string | null = null;
      const resumed = jobs.resume(snapshot.id, (current) => {
        committed = current.id;
      });
      expect(resumed.snapshot.state).toBe("queued");
      expect(committed).toBe(snapshot.id);
    } finally {
      db.db.close();
    }
  });
});
