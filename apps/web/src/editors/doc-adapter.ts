import { createElement, useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Inlines, InlineMark } from "@dmall/contracts";

export function TiptapInlineEditor(input: {
  value: Inlines;
  onChange: (value: Inlines) => void;
  onBlur?: () => void;
  readOnly?: boolean;
  ariaLabel?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        horizontalRule: false,
        dropcursor: false,
      }),
    ],
    content: inlinesToHtml(input.value),
    editable: input.readOnly !== true,
    editorProps: {
      attributes: {
        class: "tiptap-inline",
        "aria-label": input.ariaLabel ?? "正文",
      },
    },
    onUpdate: ({ editor: current }) => {
      input.onChange(htmlToInlines(current.getHTML()));
    },
    onBlur: () => input.onBlur?.(),
  });

  useEffect(() => {
    if (editor === null) return;
    if (editor.isFocused) return;
    const current = htmlToInlines(editor.getHTML());
    if (JSON.stringify(current) !== JSON.stringify(input.value)) {
      editor.commands.setContent(inlinesToHtml(input.value), { emitUpdate: false });
    }
  }, [editor, input.value]);

  return createElement(EditorContent, { editor, className: "inline-editor-host" });
}

export function inlinesToPlainText(inlines: Inlines): string {
  return inlines.map((item) => item.text).join("");
}

export function plainTextToInlines(text: string): Inlines {
  return text === "" ? [{ text: "", marks: [] }] : [{ text, marks: [] }];
}

export function inlinesToHtml(inlines: Inlines): string {
  return `<p>${inlines.map((item) => {
    let value = escapeHtml(item.text).replace(/\n/g, "<br>") || "<br>";
    for (const mark of item.marks) {
      value = applyMark(value, mark);
    }
    return value;
  }).join("") || "<br>"}</p>`;
}

export function htmlToInlines(html: string): Inlines {
  const document = new DOMParser().parseFromString(html, "text/html");
  const result: Inlines = [];
  const walk = (node: Node, marks: InlineMark[]) => {
    if (node instanceof Text) {
      if (node.data !== "") result.push({ text: node.data, marks: [...marks] });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      result.push({ text: "\n", marks: [...marks] });
      return;
    }
    const nextMarks = [...marks];
    if (node.tagName === "STRONG" || node.tagName === "B") nextMarks.push("bold");
    if (node.tagName === "EM" || node.tagName === "I") nextMarks.push("italic");
    if (node.tagName === "CODE") nextMarks.push("code");
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href !== null && /^(https?:|mailto:)/i.test(href)) {
        nextMarks.push({ type: "link", href });
      }
    }
    for (const child of node.childNodes) walk(child, nextMarks);
    if (node.tagName === "P" && node.nextSibling !== null) {
      result.push({ text: "\n", marks: [...marks] });
    }
  };
  walk(document.body, []);
  while (result.length > 1 && result.at(-1)?.text === "\n") result.pop();
  return result.length === 0 ? [{ text: "", marks: [] }] : result;
}

function applyMark(html: string, mark: InlineMark): string {
  if (mark === "bold") return `<strong>${html}</strong>`;
  if (mark === "italic") return `<em>${html}</em>`;
  if (mark === "code") return `<code>${html}</code>`;
  return `<a href="${escapeAttribute(mark.href)}">${html}</a>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
