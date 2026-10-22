import { describe, expect, it } from "vitest";
import { markdownHeadings } from "@dmall/domain";

describe("controlled Markdown ATX heading enumeration", () => {
  it.each(["```", "~~~~", "   ```md", "~~~md\u2028info", "````md\u2029info"])("omits the rest of an unclosed fence %s", (opening) => {
    expect(markdownHeadings(`# Before\n${opening}\n# Example\n## Also example\n`)).toEqual([{ id: "md-heading-1", title: "Before" }]);
  });
  it("does not open a backtick fence whose info contains a backtick", () => {
    expect(markdownHeadings("```info`invalid\n# Real\n")).toEqual([{ id: "md-heading-2", title: "Real" }]);
  });
  it("opens a tilde fence whose info contains a backtick", () => {
    expect(markdownHeadings("~~~info`valid\n# Example\n~~~\n# Real\n")).toEqual([{ id: "md-heading-4", title: "Real" }]);
  });
  it("keeps U2028 and U2029 inside physical Markdown lines", () => {
    expect(markdownHeadings("# First\u2028continued\u2029same\r# Second\r\n###### Third ######")).toEqual([
      { id: "md-heading-1", title: "First\u2028continued\u2029same" },
      { id: "md-heading-2", title: "Second" },
      { id: "md-heading-3", title: "Third" },
    ]);
  });
  it("keeps a fence open when its closing tail contains Unicode separators", () => {
    expect(markdownHeadings("```md\n```\u2028tail\n# Example\n```\u2029tail\n# Example two\n```\t\n# Real\n")).toEqual([{ id: "md-heading-7", title: "Real" }]);
  });
  it("excludes empty headings and indented code while preserving literal hashes", () => {
    expect(markdownHeadings("#\n## \t\n# ###\n   ###### ### \t\n    # Code\n\t# Code\n# Title#\n# Title ###\n# ### not closing\n# Escaped \\#\n")).toEqual([
      { id: "md-heading-7", title: "Title#" },
      { id: "md-heading-8", title: "Title" },
      { id: "md-heading-9", title: "### not closing" },
      { id: "md-heading-10", title: "Escaped \\#" },
    ]);
  });
});
