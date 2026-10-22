import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rename, symlink } from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { JobGrant, ScanItemResult } from "@dmall/contracts";
import { runScanJob } from "../../apps/worker/src/scan.js";
import { parseMarkdown } from "../../apps/worker/src/markdown.js";
import { RestrictedRoot } from "../../packages/storage/src/restricted-files.js";
function grant(root: string): JobGrant {
  const jobId = randomUUID();
  return { schemaVersion: 1, jobId, inputHash: "0".repeat(64), fence: { jobId, attempt: 1, leaseGeneration: 1, leaseOwner: "test" }, input: { schemaVersion: 1, jobType: "local_scan", sourceKind: "local_directory", rootPath: root, scanId: randomUUID(), scannerVersion: "dcw-directory-scan/1" }, checkpoint: null };
}
it("refuses queued-directory symlink replacement without reading the outside candidate", async () => {
  const base = await mkdtemp(join(tmpdir(), "boundary-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "unselected.md"), "# secret");
  let swapped = false;
  const items: ScanItemResult[] = [];
  await runScanJob(grant(root), { cancelled: () => false, emitItem: async (item) => { items.push(item); }, emitCheckpoint: cp => {
      if (!swapped && cp.visitedDirectoryCount === 1 && cp.stack.includes("sub")) {
        swapped = true;
        renameSync(join(root, "sub"), join(base, "moved"));
        symlinkSync(outside, join(root, "sub"));
      }
    } }).catch(() => undefined);
  expect(swapped).toBe(true);
  expect(items.filter(item => item.status === "candidate")).toEqual([]);
});
it("binds file reads to the verified handle and rejects replacement between check and open", async () => {
  const base = await mkdtemp(join(tmpdir(), "open-race-"));
  await mkdir(join(base, "root/sub"), { recursive: true });
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "root/sub/a.md"), "# inside");
  await writeFile(join(base, "outside/a.md"), "# outside");
  const boundary = await RestrictedRoot.capture(join(base, "root"));
  let read = false;
  await expect(boundary.withFile({ path: "sub/a.md", beforeOpen: async () => { await rename(join(base, "root/sub"), join(base, "moved")); await symlink(join(base, "outside"), join(base, "root/sub")); }, read: async ({ handle }) => { read = true; return handle.readFile("utf8"); } })).rejects.toBeDefined();
  expect(read).toBe(false);
});
it("accepts a valid UTF8 character split at 64KiB but rejects an incomplete character at EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "utf8-"));
  await writeFile(join(root, "valid.md"), "# " + "中".repeat(30000));
  await writeFile(join(root, "bad.md"), Buffer.from([35, 32, 0xe4, 0xb8]));
  const items: ScanItemResult[] = [];
  await runScanJob(grant(root), { cancelled: () => false, emitCheckpoint: () => { }, emitItem: async (item) => { items.push(item); } });
  expect(items.find(item => item.relativePath === "valid.md")?.status).toBe("candidate");
  expect(items.find(item => item.relativePath === "bad.md")?.status).toBe("unreadable");
});
it("keeps the nearest preceding block when older context needs truncating", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-"));
  const items = await parseMarkdown({ rootPath: root, relativePath: "a.md", knownFiles: [], text: "# 章节\n\n" + "远".repeat(1100) + "\n\n最近事实B\n\n![图](missing.png)\n\n后文\n\n# 下一章\n\n无关" });
  expect(items[0]?.beforeText).toContain("最近事实B");
  expect((items[0]?.beforeText.length ?? 0) + (items[0]?.afterText.length ?? 0)).toBeLessThanOrEqual(2000);
  expect(items[0]?.afterText).not.toContain("无关");
});
