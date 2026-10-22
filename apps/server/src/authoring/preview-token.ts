import { createHash } from "node:crypto";
import type {
  AcceptanceBinding,
  CandidateDecision,
  FrozenPlanAcknowledgement,
  PreviewBinding,
} from "@dmall/contracts";
import { stableJson } from "./revision-commit.js";

export function previewToken(binding: PreviewBinding): string {
  return `pt1:${createHash("sha256").update(stableJson(binding), "utf8").digest("hex")}`;
}

export function acceptanceHash(binding: AcceptanceBinding): string {
  return `ah1:${createHash("sha256").update(stableJson(binding), "utf8").digest("hex")}`;
}

export function sortedDecisions(decisions: readonly CandidateDecision[]): CandidateDecision[] {
  return [...decisions].sort((left, right) => left.groupId.localeCompare(right.groupId));
}

export function acceptanceBinding(input: {
  candidateId: string;
  payloadHash: string;
  baseRevisionId: string;
  previewCurrentRevisionId: string;
  previewToken: string;
  decisions: readonly CandidateDecision[];
  frozenPlanAcknowledgement: FrozenPlanAcknowledgement | null;
  templateVersionId: string;
  templateRulesHash: string;
  evidenceClosureHash: string;
}): AcceptanceBinding {
  return {
    schemaVersion: 1,
    algorithmVersion: "t06-acceptance/1",
    candidateId: input.candidateId,
    payloadHash: input.payloadHash,
    baseRevisionId: input.baseRevisionId,
    previewCurrentRevisionId: input.previewCurrentRevisionId,
    previewToken: input.previewToken,
    decisions: sortedDecisions(input.decisions),
    frozenPlanAcknowledgement: input.frozenPlanAcknowledgement,
    templateVersionId: input.templateVersionId,
    templateRulesHash: input.templateRulesHash,
    evidenceClosureHash: input.evidenceClosureHash,
    appliedBy: "accept_candidate",
  };
}
