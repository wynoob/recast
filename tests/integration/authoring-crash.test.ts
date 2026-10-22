import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@dmall/storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T06 real child-process crash cuts", () => {
  it.each(["revision", "refs", "evidence", "cas"])(
    "rolls back all rows after SIGKILL at %s",
    async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), `dcw-t06-crash-${boundary}-`));
      roots.push(root);
      const dbPath = join(root, "db", "workbench.sqlite");
      const childScript = join(
        process.cwd(),
        "tests/integration/fixtures/t06-crash-child.mjs",
      );
      const commitModule = join(
        process.cwd(),
        "dist/apps/server/authoring/revision-commit.js",
      );
      expect(existsSync(commitModule), "run tsc before crash tests").toBe(true);

      const child = spawn(process.execPath, [childScript, dbPath, boundary, root], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      expect(stderr).toBe("");
      expect(result).toEqual({ code: null, signal: "SIGKILL" });

      const reopened = await openDatabase({
        dbPath,
        backupDir: join(root, "backups"),
      });
      try {
        expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM revisions").get())
          .toEqual({ count: 1 });
        expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM revision_refs").get())
          .toEqual({ count: 0 });
        expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM revision_evidence").get())
          .toEqual({ count: 0 });
        expect(reopened.db.prepare(
          "SELECT current_revision_id FROM renditions",
        ).get()).toEqual(expect.objectContaining({ current_revision_id: expect.any(String) }));
        expect(reopened.db.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(reopened.db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        reopened.db.close();
      }
    },
  );
});
