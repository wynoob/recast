import { createHash } from "node:crypto";
import type { FixedEvidence } from "@dmall/contracts";
import { stableJson } from "./revision-commit.js";

export function evidenceEntityHash(evidence: FixedEvidence): string {
  if (evidence.kind === "source" || evidence.kind === "fact") return evidence.entityHash;
  if (evidence.kind === "user_assertion") return evidence.textHash;
  return createHash("sha256").update(stableJson({
    kind: "media",
    assetVersionId: evidence.assetVersionId,
    assetId: evidence.assetId,
    blobHash: evidence.blobHash,
    derivative: evidence.derivative,
    segment: evidence.segment,
    poster: evidence.poster,
  }), "utf8").digest("hex");
}

export function evidenceIndexTextHash(evidence: FixedEvidence): string | null {
  return evidence.kind === "source" || evidence.kind === "fact"
    ? evidence.indexTextHash
    : null;
}
