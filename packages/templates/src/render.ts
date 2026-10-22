import type {
  Ast,
  Block,
  ContentKind,
  DeckAst,
  DocAst,
  Inlines,
  Slide,
} from "@dmall/contracts";
import {
  InlineMarkSchema,
  type InlineMark,
} from "@dmall/contracts";
import {
  RenderInputSchema,
  type ContrastEvidence,
  type LayoutDefinition,
  type RenderResult,
  type TemplatePackage,
  type Theme,
  type ValidationIssue,
} from "@dmall/contracts";
import { SAMPLE_DATA_LABEL } from "./catalog.js";
import { sha256Hex } from "./ids.js";

interface RenderState {
  packageValue: TemplatePackage;
  ast: Ast;
  media: Record<string, string>;
  issues: ValidationIssue[];
  resources: Set<string>;
}

function issue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeLink(href: string): string | null {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

function renderInlineMark(content: string, mark: InlineMark): string {
  if (typeof mark === "string") {
    switch (mark) {
      case "bold":
        return `<strong>${content}</strong>`;
      case "italic":
        return `<em>${content}</em>`;
      case "code":
        return `<code>${content}</code>`;
    }
  }
  const parsed = InlineMarkSchema.safeParse(mark);
  if (!parsed.success || typeof parsed.data === "string") {
    return content;
  }
  const href = safeLink(parsed.data.href);
  return href === null
    ? content
    : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${content}</a>`;
}

function renderInlines(inlines: Inlines): string {
  return inlines
    .map((inline) => {
      let content = escapeHtml(inline.text);
      for (const mark of inline.marks) {
        content = renderInlineMark(content, mark);
      }
      return content;
    })
    .join("");
}

function normalizeRelativeMediaPath(input: string): string | null {
  if (
    input.length === 0 ||
    input.startsWith("/") ||
    input.startsWith("\\") ||
    input.includes("..") ||
    input.includes("\\") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(input)) return null;
  if (
    !/\.(png|jpe?g|gif|webp|svg|mp4|webm)$/i.test(input)
  ) {
    return null;
  }
  return input;
}

function resolveMedia(
  state: RenderState,
  key: string,
  path: string,
): string | null {
  const raw = state.media[key];
  if (raw === undefined) {
    state.issues.push(
      issue("MISSING_MEDIA", path, `缺少显式媒体映射: ${key}`),
    );
    return null;
  }
  const normalized = normalizeRelativeMediaPath(raw);
  if (normalized === null) {
    state.issues.push(
      issue(
        "UNSAFE_MEDIA_PATH",
        path,
        `媒体路径仅允许相对 assets 文件: ${raw}`,
      ),
    );
    return null;
  }
  state.resources.add(normalized);
  return normalized;
}

function renderMediaPlaceholder(message: string): string {
  return `<div class="media-missing" role="note">${escapeHtml(message)}</div>`;
}

function renderBlock(
  state: RenderState,
  block: Block,
  path: string,
): string {
  switch (block.type) {
    case "heading": {
      const level = Math.min(6, Math.max(3, block.level));
      return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
    }
    case "paragraph":
      return `<p>${renderInlines(block.inlines)}</p>`;
    case "callout":
      return `<div class="callout">${renderInlines(block.inlines)}</div>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag}>${block.items
        .map((item) => `<li>${renderInlines(item)}</li>`)
        .join("")}</${tag}>`;
    }
    case "table": {
      if (
        block.rows.some((row) => row.length !== block.columns.length)
      ) {
        state.issues.push(
          issue(
            "TABLE_ROW_LENGTH",
            path,
            `表格 ${block.id} 单元格数与列数不一致`,
          ),
        );
      }
      return `<div class="table-wrap"><table><thead><tr>${block.columns
        .map((column) => `<th>${escapeHtml(column)}</th>`)
        .join("")}</tr></thead><tbody>${block.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => `<td>${renderInlines(cell)}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody></table></div>`;
    }
    case "image": {
      const source = resolveMedia(
        state,
        block.derivativeId === null ? `asset_version:${block.assetVersionId}` : `derivative:${block.derivativeId}`,
        block.derivativeId === null ? `${path}.assetVersionId` : `${path}.derivativeId`,
      );
      return `<figure class="media-figure fit-${block.fit}">${
        source === null
          ? renderMediaPlaceholder("媒体未绑定，导出已阻止")
          : `<img src="${escapeHtml(source)}" alt="${escapeHtml(block.alt)}" loading="eager" decoding="sync">`
      }${
        block.caption.length === 0
          ? ""
          : `<figcaption>${escapeHtml(block.caption)}</figcaption>`
      }</figure>`;
    }
    case "video": {
      const poster = resolveMedia(
        state,
        `derivative:${block.posterDerivativeId}`,
        `${path}.posterDerivativeId`,
      );
      return `<figure class="media-figure fit-cover video-poster">${
        poster === null
          ? renderMediaPlaceholder("视频静帧未绑定，导出已阻止")
          : `<img src="${escapeHtml(poster)}" alt="${escapeHtml(block.caption || "视频静帧")}" loading="eager">`
      }<figcaption>${escapeHtml(block.caption || "视频示意")}<span class="muted">（完整视频播放由 T07 导出接入）</span></figcaption></figure>`;
    }
    case "divider":
      return "<hr>";
    case "readonly_source_block": {
      const href = safeLink(block.sourceUrl);
      return `<aside class="readonly-source"><div>${escapeHtml(block.summary)}</div>${
        href === null
          ? ""
          : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">打开来源</a>`
      }</aside>`;
    }
  }
}

function fontStack(token: Theme["typography"]["body"]): string {
  switch (token) {
    case "ui-sans":
      return `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`;
    case "ui-serif":
      return `"Songti SC", "STSong", "Noto Serif CJK SC", serif`;
    case "ui-mono":
      return `"SFMono-Regular", Menlo, Consolas, monospace`;
  }
}

function themeCss(theme: Theme): string {
  const p = theme.palette;
  return `
    --bg:${p.background};
    --bg-alt:${p.backgroundAlt};
    --surface:${p.surface};
    --surface-strong:${p.surfaceStrong};
    --text:${p.text};
    --muted:${p.muted};
    --accent:${p.accent};
    --accent-strong:${p.accentStrong};
    --accent-text:${p.accentText};
    --border:${p.border};
    --success:${p.success};
    --warning:${p.warning};
    --radius-panel:${theme.radius.panel}px;
    --radius-card:${theme.radius.card}px;
    --radius-control:${theme.radius.control}px;
    --surface-opacity:${theme.glass.surfaceOpacity};
    --border-opacity:${theme.glass.borderOpacity};
    --blur:${theme.glass.blurPx}px;
    --font-heading:${fontStack(theme.typography.heading)};
    --font-body:${fontStack(theme.typography.body)};
    --font-mono:${fontStack(theme.typography.mono)};
  `;
}

const BASE_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{
    background:
      radial-gradient(circle at 10% 0%, color-mix(in srgb, var(--accent) 32%, transparent), transparent 34rem),
      radial-gradient(circle at 92% 18%, color-mix(in srgb, var(--success) 12%, transparent), transparent 28rem),
      linear-gradient(145deg, var(--bg), var(--bg-alt) 60%, var(--bg));
    color:var(--text);font-family:var(--font-body);
    -webkit-font-smoothing:antialiased;
  }
  .sample-page{max-width:1680px;margin:0 auto;padding:28px}
  .sample-flag{
    display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;
    border:1px solid color-mix(in srgb,var(--warning) 58%, transparent);
    color:var(--warning);font-size:12px;letter-spacing:.04em;background:color-mix(in srgb,var(--surface) 80%, transparent)
  }
  .glass{
    background:color-mix(in srgb,var(--surface) calc(var(--surface-opacity) * 100%), transparent);
    border:1px solid color-mix(in srgb,var(--border) calc(var(--border-opacity) * 100%), transparent);
    border-radius:var(--radius-panel);backdrop-filter:blur(var(--blur));
    box-shadow:0 22px 70px rgba(3,2,18,.28)
  }
  h1,h2,h3,h4,h5,h6{font-family:var(--font-heading);line-height:1.15;margin:0}
  p,li,td,th{line-height:1.55}
  a{color:var(--success)}
  code{font-family:var(--font-mono);background:color-mix(in srgb,var(--bg) 58%, transparent);padding:.12em .35em;border-radius:6px}
  .muted{color:var(--muted)}
  .callout{
    padding:1.15em 1.25em;border-radius:var(--radius-card);
    border-left:5px solid var(--accent);
    background:color-mix(in srgb,var(--accent) 18%, var(--surface));
    font-size:clamp(16px,1.55cqw,26px);font-weight:650
  }
  ul,ol{margin:0;padding-left:1.4em}
  li+li{margin-top:.55em}
  hr{border:0;height:1px;background:var(--border);opacity:.55;margin:1.2em 0}
  .table-wrap{width:100%;overflow:hidden;border-radius:var(--radius-card);border:1px solid color-mix(in srgb,var(--border) 55%, transparent)}
  table{width:100%;border-collapse:collapse;table-layout:fixed;background:color-mix(in srgb,var(--surface) 72%, transparent)}
  th,td{padding:.72em .85em;text-align:left;vertical-align:top;border-bottom:1px solid color-mix(in srgb,var(--border) 36%, transparent);overflow-wrap:anywhere}
  th{font-size:.86em;color:var(--muted);background:color-mix(in srgb,var(--surface-strong) 72%, transparent)}
  tr:last-child td{border-bottom:0}
  .media-figure{margin:0;min-height:0;display:flex;flex-direction:column;gap:10px}
  .media-figure img{display:block;width:100%;height:100%;object-fit:cover;border-radius:var(--radius-card);border:1px solid color-mix(in srgb,var(--border) 52%, transparent)}
  .fit-contain img{object-fit:contain;background:var(--bg-alt)}
  .media-figure figcaption{font-size:.86em;color:var(--muted)}
  .media-missing{
    min-height:9rem;display:grid;place-items:center;text-align:center;padding:1rem;
    border:1px dashed var(--warning);border-radius:var(--radius-card);color:var(--warning);
  }
  .readonly-source{display:flex;justify-content:space-between;gap:1rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius-card)}
  .doc-paper{
    max-width:980px;margin:22px auto;padding:clamp(28px,5vw,72px);
    background:color-mix(in srgb,var(--surface) 68%, var(--bg));
    border:1px solid color-mix(in srgb,var(--border) 54%, transparent);
    border-radius:var(--radius-panel);box-shadow:0 24px 80px rgba(3,2,18,.28)
  }
  .doc-hero{padding-bottom:2.2rem;border-bottom:1px solid color-mix(in srgb,var(--border) 44%, transparent);margin-bottom:2rem}
  .doc-hero h1{font-size:clamp(34px,5.2vw,64px);letter-spacing:-.03em;margin:.55rem 0 .75rem;max-width:15em}
  .doc-hero p{color:var(--muted);font-size:clamp(16px,1.65vw,21px);margin:0;max-width:44em}
  .doc-section{padding:1.6rem 0;border-bottom:1px solid color-mix(in srgb,var(--border) 32%, transparent)}
  .doc-section:last-child{border-bottom:0}
  .doc-section h2{font-size:clamp(24px,3vw,38px);margin-bottom:1rem}
  .doc-section p{font-size:clamp(16px,1.8vw,21px)}
  .doc-section .media-figure{max-width:720px;margin-top:1.2rem}
  .deck-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 18px;margin-bottom:18px}
  .deck-title{display:flex;flex-direction:column;gap:4px}
  .deck-title strong{font-family:var(--font-heading);font-size:18px}
  .deck-title span{font-size:12px;color:var(--muted)}
  .deck-nav{display:flex;align-items:center;gap:8px}
  .deck-nav button{
    appearance:none;border:1px solid color-mix(in srgb,var(--border) 74%, transparent);
    background:color-mix(in srgb,var(--surface-strong) 82%, transparent);color:var(--text);
    min-width:42px;min-height:42px;border-radius:var(--radius-control);font:600 18px var(--font-body);cursor:pointer
  }
  .deck-nav button:hover{border-color:var(--accent)}
  .deck-count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px;min-width:62px;text-align:center}
  .slide{
    width:100%;max-width:1600px;aspect-ratio:16/9;margin:0 auto;
    background:
      radial-gradient(circle at 82% 16%, color-mix(in srgb,var(--accent) 36%, transparent), transparent 22cqw),
      radial-gradient(circle at 8% 94%, color-mix(in srgb,var(--success) 10%, transparent), transparent 24cqw),
      linear-gradient(145deg,var(--bg) 8%,var(--bg-alt) 62%,var(--bg));
    border:1px solid color-mix(in srgb,var(--border) 64%, transparent);
    border-radius:var(--radius-panel);overflow:hidden;container-type:inline-size;
    display:none;position:relative
  }
  .slide.is-active{display:block}
  .slide::after{
    content:"";position:absolute;inset:0;pointer-events:none;
    background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
    background-size:32px 32px;mask-image:linear-gradient(to bottom,black,transparent 72%)
  }
  .slide-inner{position:relative;z-index:1;height:100%;padding:5.2cqw;display:flex;flex-direction:column;gap:3.2cqw}
  .slide-meta{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:1.02cqw;letter-spacing:.08em;text-transform:uppercase}
  .slide-title{font-size:3.2cqw;letter-spacing:-.03em;max-width:84%}
  .slide-content{flex:1;min-height:0;display:grid;gap:2.4cqw;align-items:stretch}
  .slide-content p,.slide-content li,.slide-content td,.slide-content th{font-size:1.62cqw}
  .slide-content .callout{font-size:2.1cqw}
  .slide-content .table-wrap{height:100%}
  .slide-content .media-figure{height:100%;min-height:0}
  .layout-cover .slide-inner{justify-content:center;text-align:left}
  .layout-cover .slide-title{font-size:5.6cqw;max-width:88%}
  .layout-cover .slide-content{display:block;flex:0 0 auto;max-width:72%}
  .layout-section .slide-title{font-size:4.5cqw;max-width:76%}
  .layout-section .slide-content{max-width:68%;align-content:start}
  .layout-title-body-media .slide-content{grid-template-columns:minmax(0,1.18fr) minmax(0,.82fr)}
  .layout-two-column .slide-content{grid-template-columns:repeat(2,minmax(0,1fr))}
  .layout-metric-evidence .slide-content{grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);grid-template-rows:auto minmax(0,1fr)}
  .layout-metric-evidence .region-metric{grid-column:1}
  .layout-metric-evidence .region-evidence{grid-column:2;grid-row:1 / span 2}
  .layout-metric-evidence .region-explanation{grid-column:1}
  .layout-steps .slide-content{display:block;max-width:86%}
  .layout-steps ol{counter-reset:step;list-style:none;padding:0;display:grid;gap:1.4cqw}
  .layout-steps li{counter-increment:step;padding:1.3cqw 1.6cqw 1.3cqw 5cqw;position:relative;background:color-mix(in srgb,var(--surface) 64%, transparent);border:1px solid color-mix(in srgb,var(--border) 50%, transparent);border-radius:var(--radius-card)}
  .layout-steps li::before{content:counter(step,decimal-leading-zero);position:absolute;left:1.4cqw;top:1.05cqw;color:var(--accent);font:700 1.75cqw var(--font-heading)}
  .layout-table .slide-content{display:block}
  .layout-table .slide-content .table-wrap{height:100%}
  .layout-closing .slide-inner{justify-content:flex-end}
  .layout-closing .slide-content{max-width:84%;flex:0 0 auto}
  .region{min-width:0;min-height:0;display:flex;flex-direction:column;gap:1.4cqw}
  .region-media,.region-evidence{min-height:0}
  .sample-source{font-size:11px;color:var(--warning);margin-top:6px}
  .render-error{max-width:900px;margin:40px auto;padding:28px}
  @media (max-width:720px){
    .sample-page{padding:14px}
    .deck-toolbar{padding:12px}
    .deck-nav button{min-width:38px;min-height:38px}
  }
  @media print{
    @page{size:1600px 900px;margin:0}
    html,body{background:#fff}
    .sample-page{max-width:none;padding:0}
    .sample-flag,.deck-toolbar{display:none!important}
    .slide{
      display:block!important;width:1600px!important;height:900px!important;max-width:none!important;
      margin:0!important;border-radius:0!important;break-after:page;page-break-after:always;
      border:0!important;box-shadow:none!important
    }
    .slide:last-child{break-after:auto;page-break-after:auto}
    .slide-inner{height:900px!important}
    .slide *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
`;

const DOC_PRINT_CSS = `
  @media print{
    @page{size:A4;margin:16mm}
    .doc-paper{border:0;box-shadow:none;margin:0;max-width:none;background:#fff;color:#1a1630}
    .doc-paper .muted,.doc-paper figcaption{color:#5f5878}
    .sample-flag{display:none!important}
  }
`;

const DECK_SCRIPT = `
(() => {
  const slides = Array.from(document.querySelectorAll('.slide'));
  if (!slides.length) return;
  let current = 0;
  const count = document.querySelector('[data-deck-count]');
  const update = (next) => {
    current = Math.max(0, Math.min(next, slides.length - 1));
    slides.forEach((slide, index) => {
      slide.classList.toggle('is-active', index === current);
      slide.setAttribute('aria-hidden', String(index !== current));
    });
    if (count) count.textContent = String(current + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
    const hash = '#slide-' + (current + 1);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  };
  document.querySelector('[data-prev]')?.addEventListener('click', () => update(current - 1));
  document.querySelector('[data-next]')?.addEventListener('click', () => update(current + 1));
  document.querySelector('[data-fullscreen]')?.addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  });
  document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') update(current - 1);
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') update(current + 1);
  });
  const parsed = Number.parseInt(location.hash.replace('#slide-', ''), 10);
  update(Number.isFinite(parsed) ? parsed - 1 : 0);
})();
`;

function renderDoc(state: RenderState, ast: DocAst): string {
  const sections = ast.sections
    .map((section, sectionIndex) => {
      const blocks = section.blocks
        .map((block, blockIndex) =>
          renderBlock(
            state,
            block,
            `ast.sections[${sectionIndex}].blocks[${blockIndex}]`,
          ),
        )
        .join("");
      return `<section class="doc-section" id="${escapeHtml(section.id)}">
        <h2>${escapeHtml(section.title)}</h2>
        ${blocks}
      </section>`;
    })
    .join("");
  return `<main class="doc-paper glass">
    <div class="sample-flag">${escapeHtml(SAMPLE_DATA_LABEL)}</div>
    <header class="doc-hero">
      <div class="doc-kicker">${escapeHtml(state.packageValue.manifest.name)} · ${escapeHtml(state.packageValue.narrative.name)}</div>
      <h1>${escapeHtml(ast.title)}</h1>
      <p class="muted">${escapeHtml(state.packageValue.narrative.summary)}</p>
    </header>
    ${sections}
  </main>`;
}

function renderRegions(
  state: RenderState,
  slide: Slide,
  layout: LayoutDefinition,
  slideIndex: number,
): string {
  return layout.slots
    .map((layoutSlot) => {
      const blocks = slide.blocks.filter(
        (block) => block.slotId === layoutSlot.id,
      );
      if (blocks.length === 0 && layoutSlot.required) {
        state.issues.push(
          issue(
            "REQUIRED_SLOT_EMPTY",
            `ast.slides[${slideIndex}]`,
            `必填版式槽位 ${layout.id}/${layoutSlot.id} 没有块`,
          ),
        );
      }
      const rendered = blocks
        .map((block) => {
          const blockIndex = slide.blocks.findIndex((item) => item.id === block.id);
          return renderBlock(
            state,
            block,
            `ast.slides[${slideIndex}].blocks[${blockIndex}]`,
          );
        })
        .join("");
      return `<div class="region region-${escapeHtml(layoutSlot.id)}" data-slot="${escapeHtml(layoutSlot.id)}">${rendered}</div>`;
    })
    .join("");
}

function renderDeck(state: RenderState, ast: DeckAst): string {
  const slides = ast.slides
    .map((slide, slideIndex) => {
      const layout = state.packageValue.layouts.find(
        (item) => item.id === slide.layout,
      );
      if (layout === undefined) {
        state.issues.push(
          issue(
            "LAYOUT_NOT_REGISTERED",
            `ast.slides[${slideIndex}].layout`,
            `版式未注册 ${slide.layout}`,
          ),
        );
        return "";
      }
      const knownSlots = new Set(layout.slots.map((slot) => slot.id));
      for (const block of slide.blocks) {
        if (
          block.slotId === null ||
          block.slotId === undefined ||
          !knownSlots.has(block.slotId)
        ) {
          state.issues.push(
            issue(
              "BLOCK_UNPLACED",
              `ast.slides[${slideIndex}].blocks`,
              `块 ${block.id} 未映射到版式 ${layout.id}`,
            ),
          );
        }
      }
      return `<article class="slide layout-${escapeHtml(layout.id)}${slideIndex === 0 ? " is-active" : ""}" data-slide-index="${slideIndex}" aria-hidden="${slideIndex === 0 ? "false" : "true"}">
        <div class="slide-inner">
          <div class="slide-meta">
            <span>${escapeHtml(state.packageValue.manifest.name)}</span>
            <span>${escapeHtml(SAMPLE_DATA_LABEL)}</span>
          </div>
          <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
          <div class="slide-content" data-slide-content>
            ${renderRegions(state, slide, layout, slideIndex)}
          </div>
        </div>
      </article>`;
    })
    .join("");
  return `<main class="sample-page deck-sample">
    <div class="deck-toolbar glass">
      <div class="deck-title">
        <strong>${escapeHtml(ast.title)}</strong>
        <span>${escapeHtml(state.packageValue.narrative.name)} · 1600×900 · ${escapeHtml(SAMPLE_DATA_LABEL)}</span>
      </div>
      <div class="deck-nav" aria-label="演示翻页">
        <button type="button" data-prev aria-label="上一页">←</button>
        <span class="deck-count" data-deck-count>01 / ${String(ast.slides.length).padStart(2, "0")}</span>
        <button type="button" data-next aria-label="下一页">→</button>
        <button type="button" data-fullscreen aria-label="全屏">⛶</button>
        <button type="button" data-print aria-label="打印">⌘P</button>
      </div>
    </div>
    <div class="deck-stack">${slides}</div>
  </main>`;
}

function htmlDocument(input: {
  title: string;
  theme: Theme;
  body: string;
  script: string;
  documentMode: boolean;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>:root{${themeCss(input.theme)}}${BASE_CSS}${input.documentMode ? DOC_PRINT_CSS : ""}</style>
</head>
<body>
${input.body}
<script>${input.script}</script>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>模板渲染失败</title></head><body><div class="render-error"><h1>模板渲染失败</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function readKind(input: unknown): ContentKind {
  if (input !== null && typeof input === "object" && "instance" in input) {
    const instance = input.instance;
    if (
      instance !== null &&
      typeof instance === "object" &&
      "ast" in instance &&
      instance.ast !== null &&
      typeof instance.ast === "object" &&
      "kind" in instance.ast &&
      (instance.ast.kind === "feishu_doc" || instance.ast.kind === "html_deck")
    ) {
      return instance.ast.kind;
    }
  }
  if (input !== null && typeof input === "object" && "ast" in input) {
    const ast = input.ast;
    if (
      ast !== null &&
      typeof ast === "object" &&
      "kind" in ast &&
      (ast.kind === "feishu_doc" || ast.kind === "html_deck")
    ) {
      return ast.kind;
    }
  }
  return "feishu_doc";
}

function readVersion(input: unknown): string {
  if (input !== null && typeof input === "object" && "instance" in input) {
    const instance = input.instance;
    if (
      instance !== null &&
      typeof instance === "object" &&
      "templateSnapshot" in instance &&
      instance.templateSnapshot !== null &&
      typeof instance.templateSnapshot === "object" &&
      "manifest" in instance.templateSnapshot &&
      instance.templateSnapshot.manifest !== null &&
      typeof instance.templateSnapshot.manifest === "object" &&
      "templateVersionId" in instance.templateSnapshot.manifest &&
      typeof instance.templateSnapshot.manifest.templateVersionId === "string"
    ) {
      return instance.templateSnapshot.manifest.templateVersionId;
    }
  }
  if (
    input !== null &&
    typeof input === "object" &&
    "templatePackage" in input &&
    input.templatePackage !== null &&
    typeof input.templatePackage === "object" &&
    "manifest" in input.templatePackage &&
    input.templatePackage.manifest !== null &&
    typeof input.templatePackage.manifest === "object" &&
    "templateVersionId" in input.templatePackage.manifest &&
    typeof input.templatePackage.manifest.templateVersionId === "string"
  ) {
    return input.templatePackage.manifest.templateVersionId;
  }
  return "00000000-0000-4000-8000-000000000000";
}

export function renderTemplateSample(input: unknown): RenderResult {
  const parsed = RenderInputSchema.safeParse(input);
  if (!parsed.success) {
    const html = errorPage(parsed.error.issues[0]?.message ?? "渲染输入无效");
    return {
      ok: false,
      html,
      artifactHash: sha256Hex(html),
      resourcePaths: [],
      issues: parsed.error.issues.map((item) =>
        issue("RENDER_INPUT_INVALID", item.path.map(String).join("."), item.message),
      ),
      kind: readKind(input),
      templateVersionId: readVersion(input),
    };
  }
  const data = parsed.data;
  const instance = data.instance;
  const packageValue = instance?.templateSnapshot ?? data.templatePackage;
  const ast = instance?.ast ?? data.ast;
  if (packageValue === undefined || ast === undefined) {
    const html = errorPage("渲染缺少模板包或 AST");
    return {
      ok: false,
      html,
      artifactHash: sha256Hex(html),
      resourcePaths: [],
      issues: [issue("RENDER_INPUT_INVALID", "input", "缺少模板包或 AST")],
      kind: readKind(input),
      templateVersionId: readVersion(input),
    };
  }
  const state: RenderState = {
    packageValue,
    ast,
    media: data.media,
    issues: [],
    resources: new Set<string>(),
  };
  const body =
    ast.kind === "feishu_doc" ? renderDoc(state, ast) : renderDeck(state, ast);
  const html = htmlDocument({
    title: `${packageValue.manifest.name} · ${SAMPLE_DATA_LABEL}`,
    theme: packageValue.theme,
    body,
    script: ast.kind === "html_deck" ? DECK_SCRIPT : "",
    documentMode: ast.kind === "feishu_doc",
  });
  return {
    ok: state.issues.length === 0,
    html,
    artifactHash: sha256Hex(html),
    resourcePaths: [...state.resources].sort(),
    issues: state.issues,
    kind: ast.kind,
    templateVersionId: packageValue.manifest.templateVersionId,
  };
}

function channelToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export function computeThemeContrast(theme: Theme): ContrastEvidence {
  const textOnBackground = contrastRatio(
    theme.palette.text,
    theme.palette.background,
  );
  const mutedOnBackground = contrastRatio(
    theme.palette.muted,
    theme.palette.background,
  );
  const accentTextOnAccent = contrastRatio(
    theme.palette.accentText,
    theme.palette.accent,
  );
  return {
    textOnBackground,
    mutedOnBackground,
    accentTextOnAccent,
    minimum: Math.min(
      textOnBackground,
      mutedOnBackground,
      accentTextOnAccent,
    ),
  };
}

export function layoutSampleIds(): string[] {
  return [
    "cover",
    "section",
    "title-body-media",
    "two-column",
    "metric-evidence",
    "steps",
    "table",
    "closing",
  ];
}
