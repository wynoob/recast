import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  TemplateInstanceSchema,
  TemplatePackageSchema,
  createSyntheticSample,
  renderTemplateSample,
  validateTemplatePackage,
} from "../src/index.js";

const NOW = "2026-10-21T08:00:00.000Z";

describe("template ready review", () => {
  it("accepts a structurally valid draft but does not claim ready", () => {
    const sample = createSyntheticSample("product-intro", "feishu_doc");
    const result = validateTemplatePackage(sample.packageValue);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("draft");
    expect(result.readyReview).toBeNull();
  });

  it("requires real Chromium evidence before returning a ready review pass", () => {
    const sample = createSyntheticSample("phase-review", "feishu_doc");
    const result = validateTemplatePackage(sample.packageValue, {
      mode: "ready",
      sample: {
        ast: sample.instance.ast,
        media: sample.mediaPaths,
      },
      instance: sample.instance,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.readyReview?.decision).toBe("blocked");
    expect(result.issues.map((item) => item.code)).toContain(
      "SAMPLE_RENDER_EVIDENCE_REQUIRED",
    );
  });

  it("rejects evidence copied from another rendered sample", () => {
    const sample = createSyntheticSample("executive-progress", "html_deck");
    const result = validateTemplatePackage(sample.packageValue, {
      mode: "ready",
      sample: {
        ast: sample.instance.ast,
        media: sample.mediaPaths,
      },
      instance: sample.instance,
      evidence: {
        source: "chromium",
        rendererVersion: "deck-1",
        sampleHash: "0".repeat(64),
        templateHash: canonicalHash(sample.packageValue),
        astHash: canonicalHash(sample.instance.ast),
        loaded: true,
        missingResources: [],
        externalRequests: [],
        overflow: { screen: false, print: false },
        print: {
          pages: 8,
          pdfBytes: 100,
          pdfSha256: "a".repeat(64),
        },
        contrast: {
          textOnBackground: 10,
          mutedOnBackground: 8,
          accentTextOnAccent: 6,
          minimum: 6,
        },
        checkedAt: NOW,
      },
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain(
      "RENDER_EVIDENCE_HASH_MISMATCH",
    );
  });

  it("blocks low-contrast themes even when evidence shape is valid", () => {
    const sample = createSyntheticSample("training", "feishu_doc");
    const lowPackage = TemplatePackageSchema.parse({
      ...sample.packageValue,
      theme: {
        ...sample.packageValue.theme,
        palette: {
          ...sample.packageValue.theme.palette,
          text: sample.packageValue.theme.palette.background,
          muted: sample.packageValue.theme.palette.background,
          accentText: sample.packageValue.theme.palette.accent,
        },
      },
    });
    const lowInstance = TemplateInstanceSchema.parse({
      ...sample.instance,
      templateSnapshot: lowPackage,
    });
    const render = renderTemplateSample({
      instance: lowInstance,
      media: sample.mediaPaths,
    });
    const result = validateTemplatePackage(lowPackage, {
      mode: "ready",
      sample: {
        ast: lowInstance.ast,
        media: sample.mediaPaths,
      },
      instance: lowInstance,
      evidence: {
        source: "chromium",
        rendererVersion: "docx-1",
        sampleHash: render.artifactHash,
        templateHash: canonicalHash(lowPackage),
        astHash: canonicalHash(lowInstance.ast),
        loaded: true,
        missingResources: [],
        externalRequests: [],
        overflow: { screen: false, print: false },
        print: {
          pages: 1,
          pdfBytes: 100,
          pdfSha256: "b".repeat(64),
        },
        contrast: {
          textOnBackground: 1,
          mutedOnBackground: 1,
          accentTextOnAccent: 1,
          minimum: 1,
        },
        checkedAt: NOW,
      },
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain(
      "CONTRAST_TOO_LOW",
    );
  });
});
