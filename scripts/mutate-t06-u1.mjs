import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const target = resolve("apps/server/src/authoring/revisions.ts");
const original = readFileSync(target);
const beforeHash = createHash("sha256").update(original).digest("hex");
const source = original.toString("utf8");
const needle = "if (replay !== null) return replay;";
if (source.split(needle).length < 2) {
  throw new Error("expected idempotency replay guards");
}

try {
  writeFileSync(
    target,
    source.replace(needle, "if (replay !== null && false) return replay;"),
  );
  const run = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/integration/authoring-revisions.test.ts",
      "-t",
      "saves, replays, rejects a different body",
      "--reporter=verbose",
    ],
    { encoding: "utf8", env: process.env },
  );
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  console.log(output);
  const assertionFailed =
    run.status !== 0 &&
    output.includes("expected 409 to be 201");
  if (!assertionFailed) {
    throw new Error("idempotency mutation was not detected by the replay assertion");
  }
  console.log("MUTATION_DETECTED idempotency-replay");
} finally {
  writeFileSync(target, original);
}

const afterHash = createHash("sha256").update(readFileSync(target)).digest("hex");
if (afterHash !== beforeHash) throw new Error("source was not restored after mutation");
console.log(JSON.stringify({ beforeHash, afterHash, restored: true }));
