import { describe, expect, it } from "vitest";
import { InlineMarkSchema } from "@dmall/contracts";
import { TemplateInstanceSchema } from "@dmall/contracts";
import {
  createSyntheticSample,
  renderTemplateSample,
} from "../src/index.js";

describe("controlled sample renderer", () => {
  it("renders escaped document content without remote assets or user scripts", () => {
    const sample = createSyntheticSample("phase-review", "feishu_doc");
    const malicious = structuredClone(sample.instance);
    if (malicious.ast.kind !== "feishu_doc") throw new Error("样例不是文档 AST");
    const firstSection = malicious.ast.sections[0];
    const firstBlock = firstSection?.blocks[0];
    if (firstBlock?.type === "paragraph") {
      firstBlock.inlines = [
        {
          text: '<img src=x onerror=alert(1)><script>alert(2)</script>',
          marks: [],
        },
      ];
    }
    const parsed = TemplateInstanceSchema.parse(malicious);
    const render = renderTemplateSample({
      instance: parsed,
      media: sample.mediaPaths,
    });
    expect(render.ok).toBe(true);
    expect(render.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(render.html).not.toContain("<img src=x");
    expect(render.html).not.toContain("<script>alert(2)</script>");
    expect(render.html).not.toMatch(/<link\b/i);
    expect(render.html).not.toMatch(/fonts\.googleapis|@import|script\s+src/i);
  });

  it("rejects unsafe link marks at the AST boundary", () => {
    expect(
      InlineMarkSchema.safeParse({
        type: "link",
        href: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      InlineMarkSchema.safeParse({
        type: "link",
        href: "data:text/html,<script>alert(1)</script>",
      }).success,
    ).toBe(false);
    expect(
      InlineMarkSchema.safeParse({
        type: "link",
        href: "https://example.com/source",
      }).success,
    ).toBe(true);
  });

  it("fails closed for remote, traversing and missing media paths", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    const remote = renderTemplateSample({
      instance: sample.instance,
      media: {
        ...sample.mediaPaths,
        [`derivative:${sample.materials[0]?.kind === "image" ? sample.materials[0].derivativeId : ""}`]: "https://example.com/a.png",
      },
    });
    expect(remote.ok).toBe(false);
    expect(remote.issues.map((item) => item.code)).toContain("UNSAFE_MEDIA_PATH");

    const traversing = renderTemplateSample({
      instance: sample.instance,
      media: {
        ...sample.mediaPaths,
        [`derivative:${sample.materials[0]?.kind === "image" ? sample.materials[0].derivativeId : ""}`]: "../secret.png",
      },
    });
    expect(traversing.ok).toBe(false);
    expect(traversing.issues.map((item) => item.code)).toContain(
      "UNSAFE_MEDIA_PATH",
    );

    const missing = renderTemplateSample({
      instance: sample.instance,
      media: {},
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues.map((item) => item.code)).toContain("MISSING_MEDIA");
  });

  it("renders article and deck samples with a stable artifact hash", () => {
    for (const kind of ["feishu_doc", "html_deck"] as const) {
      const sample = createSyntheticSample("internal-sharing", kind);
      const first = renderTemplateSample({
        instance: sample.instance,
        media: sample.mediaPaths,
      });
      const second = renderTemplateSample({
        instance: sample.instance,
        media: sample.mediaPaths,
      });
      expect(first.ok).toBe(true);
      expect(first.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.artifactHash).toBe(second.artifactHash);
      expect(first.resourcePaths).toEqual(
        expect.arrayContaining(["assets/synthetic-flow.svg"]),
      );
    }
  });
});
