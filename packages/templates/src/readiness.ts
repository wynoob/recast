import {
  BriefSchema,
  TemplatePackageSchema,
  TemplateReadinessSchema,
  TemplateVersionIdSchema,
  type TemplatePackage,
  type TemplateReadiness,
  type TemplateReadinessIssue,
} from "@dmall/contracts";

const BRIEF_FIELDS = new Set(["title", "goal", "tone", "durationMinutes"]);

export function assessTemplateReadiness(input: {
  templatePackage: unknown;
  brief: unknown;
}): TemplateReadiness {
  const templatePackage: TemplatePackage = TemplatePackageSchema.parse(input.templatePackage);
  const brief = BriefSchema.parse(input.brief);
  const issues: TemplateReadinessIssue[] = [];
  const templateVersionId = TemplateVersionIdSchema.parse(
    templatePackage.manifest.templateVersionId,
  );
  const needed = new Set(
    templatePackage.slots.flatMap((slot) =>
      slot.source.kind === "brief" && BRIEF_FIELDS.has(slot.source.field)
        ? [slot.source.field]
        : [],
    ),
  );
  if ((needed.has("goal") || needed.has("title")) && brief.goal.trim() === "") {
    issues.push({
      kind: "goal_required",
      path: "brief.goal",
      templateVersionId,
    });
  }
  if (needed.has("tone") && brief.tone.trim() === "") {
    issues.push({
      kind: "tone_required",
      path: "brief.tone",
      templateVersionId,
    });
  }
  if (needed.has("durationMinutes") && brief.durationMinutes === null) {
    issues.push({
      kind: "duration_required",
      path: "brief.durationMinutes",
      templateVersionId,
    });
  }
  const unresolvedQuestions = brief.unresolvedQuestions.map((originalText, index) => ({
    index,
    originalText,
  }));
  if (issues.length === 0 && unresolvedQuestions.length === 0) {
    return TemplateReadinessSchema.parse({ kind: "ready" });
  }
  return TemplateReadinessSchema.parse({
    kind: "waiting_input",
    issues,
    unresolvedQuestions,
  });
}
