import {
  InlineMarkSchema,
  type Ast,
  type Block,
  type DeckAst,
  type DocAst,
  type InlineMark,
  type Inlines,
  type Slide,
  type TemplatePackage,
  type Theme,
} from "@dmall/contracts";

// Reserved for snapshots created only by the no-fixed-template output adapter.
export const MANUAL_OUTPUT_TEMPLATE_ID = "f9be1707-0a69-4dc8-9eb5-0c57ee6e4858";

export function manualOutputTemplate(template: TemplatePackage): TemplatePackage {
  const result = structuredClone(template);
  result.manifest.id = MANUAL_OUTPUT_TEMPLATE_ID;
  result.manifest.changeSummary = "builtin-manual-output/1";
  result.manifest.name = "自由创作基础布局";
  for (const layout of result.layouts) {
    layout.slots = [{
      id: "manual-content",
      label: "页面内容",
      blockTypes: ["paragraph", "callout", "list", "table", "image", "video", "divider"],
      required: false,
    }];
  }
  result.slots = result.slots.map((slot) => ({ ...slot, layoutSlotId: "manual-content" }));
  return result;
}

function isManualOutput(template: TemplatePackage): boolean {
  return template.manifest.id === MANUAL_OUTPUT_TEMPLATE_ID && template.manifest.changeSummary === "builtin-manual-output/1";
}

export interface OutputRenderIssue {
  code: string;
  nodeId: string | null;
  message: string;
}

export interface OutputStaticizedMedia {
  nodeId: string;
  from: "gif" | "video";
  message: string;
}

export interface ProductionRenderInput {
  ast: Ast;
  template: TemplatePackage;
  media: Record<string, string>;
  includeSpeakerNotes: boolean;
  mode: "html" | "pdf";
}

export interface ProductionRenderResult {
  ok: boolean;
  html: string;
  resourcePaths: string[];
  issues: OutputRenderIssue[];
  staticized: OutputStaticizedMedia[];
}

interface RenderState {
  media: Record<string, string>;
  resources: Set<string>;
  issues: OutputRenderIssue[];
  staticized: OutputStaticizedMedia[];
  mode: "html" | "pdf";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeExportLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if (url.protocol === "mailto:") return value;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local") ||
      /^127\./u.test(host) ||
      /^10\./u.test(host) ||
      /^192\.168\./u.test(host) ||
      /^169\.254\./u.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./u.test(host)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function normalizeRelativePath(value: string): string | null {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("..") ||
    value.includes("\\") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value)
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9._/-]+$/u.test(value)) return null;
  return value;
}

function renderInlineMark(content: string, mark: InlineMark): string {
  if (typeof mark === "string") {
    if (mark === "bold") return `<strong>${content}</strong>`;
    if (mark === "italic") return `<em>${content}</em>`;
    return `<code>${content}</code>`;
  }
  const parsed = InlineMarkSchema.safeParse(mark);
  if (!parsed.success || typeof parsed.data === "string") return content;
  const href = safeExportLink(parsed.data.href);
  return href === null
    ? content
    : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${content}</a>`;
}

function renderInlines(inlines: Inlines): string {
  return inlines
    .map((inline) => {
      let content = escapeHtml(inline.text);
      for (const mark of inline.marks) content = renderInlineMark(content, mark);
      return content;
    })
    .join("");
}

function mediaPath(state: RenderState, key: string, nodeId: string): string | null {
  const raw = state.media[key];
  if (raw === undefined) {
    state.issues.push({
      code: "EXPORT_MEDIA_MISSING",
      nodeId,
      message: `缺少导出媒体：${key}`,
    });
    return null;
  }
  const normalized = normalizeRelativePath(raw);
  if (normalized === null) {
    state.issues.push({
      code: "EXPORT_MEDIA_MISSING",
      nodeId,
      message: `导出媒体路径不安全：${raw}`,
    });
    return null;
  }
  state.resources.add(normalized);
  return normalized;
}

function imageKey(block: Extract<Block, { type: "image" }>): string {
  return block.derivativeId === null
    ? `asset_version:${block.assetVersionId}`
    : `derivative:${block.derivativeId}`;
}

function renderBlock(state: RenderState, block: Block): string {
  switch (block.type) {
    case "heading":
      return `<h${Math.min(6, Math.max(3, block.level))}>${escapeHtml(block.text)}</h${Math.min(6, Math.max(3, block.level))}>`;
    case "paragraph":
      return `<p>${renderInlines(block.inlines)}</p>`;
    case "callout":
      return `<aside class="callout">${renderInlines(block.inlines)}</aside>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag}>${block.items.map((item) => `<li>${renderInlines(item)}</li>`).join("")}</${tag}>`;
    }
    case "table":
      return `<div class="table-wrap"><table><thead><tr>${block.columns
        .map((column) => `<th>${escapeHtml(column)}</th>`)
        .join("")}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInlines(cell)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
    case "image": {
      const source = mediaPath(state, imageKey(block), block.id);
      return `<figure class="media-figure fit-${block.fit}">${
        source === null
          ? `<div class="media-missing">关键图片缺失，已阻止导出</div>`
          : `<img src="${escapeHtml(source)}" alt="${escapeHtml(block.alt)}" loading="eager" decoding="sync">`
      }${block.caption === "" ? "" : `<figcaption>${escapeHtml(block.caption)}</figcaption>`}</figure>`;
    }
    case "video": {
      const poster = mediaPath(state, `derivative:${block.posterDerivativeId}`, block.id);
      const video = mediaPath(state, `asset_version:${block.assetVersionId}`, block.id);
      if (poster === null) {
        return `<figure class="media-figure"><div class="media-missing">视频静帧缺失，已阻止导出</div></figure>`;
      }
      if (state.mode === "pdf" || video === null) {
        state.staticized.push({
          nodeId: block.id,
          from: "video",
          message: "视频在 PDF 中静态化为封面帧",
        });
        return `<figure class="media-figure fit-cover video-poster"><img src="${escapeHtml(poster)}" alt="${escapeHtml(block.caption || "视频封面帧")}" loading="eager"><figcaption>${escapeHtml(block.caption || "视频")}<span class="muted">（PDF 已静态化）</span></figcaption></figure>`;
      }
      return `<figure class="media-figure fit-cover video-poster"><video controls muted playsinline preload="metadata" poster="${escapeHtml(poster)}" src="${escapeHtml(video)}" data-video-node="${escapeHtml(block.id)}"></video><figcaption>${escapeHtml(block.caption || "视频")}<span class="muted">（默认静音，点击播放）</span></figcaption></figure>`;
    }
    case "divider":
      return "<hr>";
    case "readonly_source_block": {
      const href = safeExportLink(block.sourceUrl);
      const preview = block.previewDerivativeId === null
        ? null
        : mediaPath(state, `derivative:${block.previewDerivativeId}`, block.id);
      return `<aside class="readonly-source">${
        preview === null ? "" : `<img class="readonly-preview" src="${escapeHtml(preview)}" alt="只读来源预览">`
      }<div><strong>只读来源块</strong><p>${escapeHtml(block.summary)}</p></div>${
        href === null ? `<span class="muted">来源链接已从离线输出移除</span>` : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">打开来源</a>`
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
  body{background:radial-gradient(circle at 9% 0%,color-mix(in srgb,var(--accent) 28%,transparent),transparent 34rem),radial-gradient(circle at 92% 18%,color-mix(in srgb,var(--success) 10%,transparent),transparent 28rem),linear-gradient(145deg,var(--bg),var(--bg-alt) 60%,var(--bg));color:var(--text);font-family:var(--font-body);-webkit-font-smoothing:antialiased}
  a{color:var(--success)}code{font-family:var(--font-mono);background:color-mix(in srgb,var(--bg) 58%,transparent);padding:.12em .35em;border-radius:6px}
  h1,h2,h3,h4,h5,h6{font-family:var(--font-heading);line-height:1.15;margin:0}
  p,li,td,th{line-height:1.58}
  ul,ol{margin:0;padding-left:1.35em}li+li{margin-top:.5em}
  .muted{color:var(--muted)}
  .callout{padding:1.1em 1.25em;border-radius:var(--radius-card);border-left:5px solid var(--accent);background:color-mix(in srgb,var(--accent) 18%,var(--surface));font-weight:650}
  hr{border:0;height:1px;background:var(--border);opacity:.55;margin:1.2em 0}
  .table-wrap{width:100%;overflow:hidden;border-radius:var(--radius-card);border:1px solid color-mix(in srgb,var(--border) 60%,transparent)}
  table{width:100%;border-collapse:collapse;table-layout:fixed;background:color-mix(in srgb,var(--surface) 72%,transparent)}
  th,td{padding:.72em .85em;text-align:left;vertical-align:top;border-bottom:1px solid color-mix(in srgb,var(--border) 36%,transparent);overflow-wrap:anywhere}
  th{font-size:.88em;color:var(--muted);background:color-mix(in srgb,var(--surface-strong) 76%,transparent)}tr:last-child td{border-bottom:0}
  .media-figure{margin:0;min-height:0;display:flex;flex-direction:column;gap:10px}
  .media-figure img,.media-figure video{display:block;width:100%;height:100%;max-height:100%;object-fit:cover;border-radius:var(--radius-card);border:1px solid color-mix(in srgb,var(--border) 52%,transparent);background:var(--bg-alt)}
  .fit-contain img,.fit-contain video{object-fit:contain}
  .media-figure figcaption{font-size:.88em;color:var(--muted)}
  .media-missing{min-height:9rem;display:grid;place-items:center;text-align:center;padding:1rem;border:1px dashed var(--warning);border-radius:var(--radius-card);color:var(--warning)}
  .readonly-source{display:flex;justify-content:space-between;gap:1rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius-card);background:color-mix(in srgb,var(--surface) 66%,transparent)}
  .readonly-preview{width:min(38%,280px);aspect-ratio:16/10;object-fit:cover;border-radius:calc(var(--radius-card) - 4px)}
  .shell{max-width:1760px;margin:0 auto;padding:22px}
  .capsule{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 17px;border-radius:999px;background:color-mix(in srgb,var(--surface) 78%,transparent);border:1px solid color-mix(in srgb,var(--border) 68%,transparent);backdrop-filter:blur(var(--blur));position:sticky;top:12px;z-index:20}
  .capsule strong{font-family:var(--font-heading);font-size:16px}.capsule small{display:block;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  .nav{display:flex;align-items:center;gap:8px}.nav button{appearance:none;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);background:var(--surface-strong);color:var(--text);min-width:40px;min-height:40px;border-radius:999px;font:600 17px var(--font-body);cursor:pointer}
  .counter{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;min-width:58px;text-align:center}
  .deck{padding-top:18px}.slide{width:100%;max-width:1600px;aspect-ratio:16/9;margin:0 auto;background:radial-gradient(circle at 82% 16%,color-mix(in srgb,var(--accent) 34%,transparent),transparent 22cqw),radial-gradient(circle at 8% 94%,color-mix(in srgb,var(--success) 10%,transparent),transparent 24cqw),linear-gradient(145deg,var(--bg) 8%,var(--bg-alt) 62%,var(--bg));border:1px solid color-mix(in srgb,var(--border) 64%,transparent);border-radius:24px;overflow:hidden;container-type:inline-size;display:none;position:relative}
  .slide.is-active{display:block}.slide::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(to bottom,black,transparent 72%)}
  .slide-inner{position:relative;z-index:1;height:100%;padding:5.2cqw;display:flex;flex-direction:column;gap:3.2cqw}.slide-meta{display:flex;justify-content:space-between;color:var(--muted);font-size:1.02cqw;letter-spacing:.08em;text-transform:uppercase}
  .slide-title{font-size:3.2cqw;letter-spacing:-.03em;max-width:84%}.slide-content{flex:1;min-height:0;display:grid;gap:2.4cqw;align-items:stretch}.slide-content p,.slide-content li,.slide-content td,.slide-content th{font-size:1.62cqw}.slide-content .callout{font-size:2.1cqw}.slide-content .media-figure{height:100%;min-height:0}
  .layout-cover .slide-inner{justify-content:center}.layout-cover .slide-title{font-size:5.6cqw;max-width:88%}.layout-cover .slide-content{display:block;flex:0 0 auto;max-width:72%}
  .layout-section .slide-title{font-size:4.5cqw;max-width:76%}.layout-section .slide-content{max-width:68%;align-content:start}
  .layout-title-body-media .slide-content{grid-template-columns:minmax(0,1.18fr) minmax(0,.82fr)}.layout-two-column .slide-content{grid-template-columns:repeat(2,minmax(0,1fr))}
  .layout-metric-evidence .slide-content{grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);grid-template-rows:auto minmax(0,1fr)}.layout-steps .slide-content{display:block;max-width:86%}
  .layout-table .slide-content{display:block}.layout-closing .slide-inner{justify-content:flex-end}.layout-closing .slide-content{max-width:84%;flex:0 0 auto}
  .region{min-width:0;min-height:0;display:flex;flex-direction:column;gap:1.4cqw}
  .manual-slide{aspect-ratio:auto;min-height:900px;overflow:visible}
  .manual-slide .slide-inner{height:auto;min-height:900px}
  .manual-slide .slide-content{display:flex;flex-direction:column}
  .manual-slide .slide-title{overflow-wrap:anywhere}
  .manual-slide .region{overflow-wrap:anywhere;white-space:pre-wrap}
  .manual-slide .media-figure img,.manual-slide .media-figure video{height:auto;max-height:420px;object-fit:contain}
  .notes{margin:16px auto 0;max-width:1600px;border:1px solid color-mix(in srgb,var(--border) 58%,transparent);border-radius:16px;background:color-mix(in srgb,var(--surface) 74%,transparent);padding:14px 18px;white-space:pre-wrap}
  .notes[hidden]{display:none}.doc{max-width:1020px;margin:22px auto;padding:clamp(30px,5vw,72px);background:color-mix(in srgb,var(--surface) 70%,var(--bg));border:1px solid color-mix(in srgb,var(--border) 54%,transparent);border-radius:24px}
  .doc-hero{padding-bottom:2rem;border-bottom:1px solid color-mix(in srgb,var(--border) 44%,transparent);margin-bottom:1.8rem}.doc-hero h1{font-size:clamp(34px,5vw,62px);letter-spacing:-.03em;margin:.4rem 0 .8rem}.doc-hero p{color:var(--muted);font-size:clamp(16px,1.6vw,21px);margin:0}
  .doc-section{padding:1.5rem 0;border-bottom:1px solid color-mix(in srgb,var(--border) 32%,transparent)}.doc-section:last-child{border-bottom:0}.doc-section h2{font-size:clamp(24px,2.8vw,36px);margin-bottom:1rem}.doc-section .media-figure{max-width:760px;margin-top:1.1rem}
  .doc-notes{margin-top:2rem;padding-top:1.2rem;border-top:1px dashed var(--border)}.doc-notes[hidden]{display:none}
  @media (max-width:760px){.shell{padding:12px}.capsule{position:static}.nav button{min-width:36px;min-height:36px}.slide{border-radius:18px}.notes{border-radius:12px}}
  @media print{
    @page{size:1600px 900px;margin:0}
    html,body{background:#fff}.shell{max-width:none;padding:0}.capsule,.notes-toggle{display:none!important}
    .slide{display:block!important;width:1600px!important;height:900px!important;max-width:none!important;margin:0!important;border-radius:0!important;break-after:page;page-break-after:always;border:0!important;box-shadow:none!important}
    .slide.manual-slide{height:auto!important;min-height:900px!important;overflow:visible!important}
    .slide.manual-slide .slide-inner{height:auto!important;min-height:900px!important}
    .slide:last-child{break-after:auto;page-break-after:auto}.slide-inner{height:900px!important}.slide *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .doc{max-width:none;margin:0;border:0;background:#fff;color:#17132d;padding:64px 74px}.doc-hero h1{font-size:48px}.doc-section{break-inside:avoid}.doc .muted,.doc figcaption{color:#625b7c}
    .notes{display:none!important}
    body[data-notes-included="true"] .notes{
      display:flex!important;width:1600px!important;height:900px!important;max-width:none!important;
      padding:80px 96px!important;border:0!important;border-radius:0!important;background:#fff!important;
      color:#17132d!important;font-size:22px!important;line-height:1.7!important;white-space:pre-wrap!important;
      break-after:page;page-break-after:always
    }
  }
`;

export const DECK_SCRIPT = `
(() => {
  const slides = Array.from(document.querySelectorAll('.slide'));
  if (!slides.length) return;
  let current = 0;
  const count = document.querySelector('[data-count]');
  const notes = Array.from(document.querySelectorAll('[data-speaker-notes]'));
  const update = (next) => {
    current = Math.max(0, Math.min(next, slides.length - 1));
    slides.forEach((slide, index) => {
      slide.classList.toggle('is-active', index === current);
      slide.setAttribute('aria-hidden', String(index !== current));
    });
    notes.forEach((note, index) => note.hidden = index !== current || document.body.dataset.notesState !== 'on');
    if (count) count.textContent = String(current + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
    if (location.hash !== '#slide-' + (current + 1)) location.replace('#slide-' + (current + 1));
  };
  document.querySelector('[data-prev]')?.addEventListener('click', () => update(current - 1));
  document.querySelector('[data-next]')?.addEventListener('click', () => update(current + 1));
  document.querySelector('[data-fullscreen]')?.addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  });
  document.querySelector('[data-notes-toggle]')?.addEventListener('click', () => {
    document.body.dataset.notesState = document.body.dataset.notesState === 'on' ? 'off' : 'on';
    update(current);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') update(current - 1);
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') update(current + 1);
    if (event.key === 'f' || event.key === 'F') document.querySelector('[data-fullscreen]')?.click();
  });
  document.querySelectorAll('video').forEach((video) => {
    video.addEventListener('click', () => {
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    });
  });
  const parsed = Number.parseInt(location.hash.replace('#slide-', ''), 10);
  update(Number.isFinite(parsed) ? parsed - 1 : 0);
})();
`;

function renderDoc(state: RenderState, ast: DocAst, template: TemplatePackage, includeNotes: boolean): string {
  const sections = ast.sections
    .map((section) => {
      const notes = ast.speakerNotes[section.id];
      return `<section class="doc-section" id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>${section.blocks
        .map((block) => renderBlock(state, block))
        .join("")}${
        includeNotes && notes !== undefined && notes.trim() !== ""
          ? `<div class="doc-notes"><strong>讲稿</strong><p>${escapeHtml(notes)}</p></div>`
          : ""
      }</section>`;
    })
    .join("");
  return `<div class="shell"><header class="capsule"><div><strong>${escapeHtml(ast.title)}</strong><small>${escapeHtml(template.manifest.name)} · 离线文档</small></div><div class="nav"><span class="counter">固定修订版本</span></div></header><main class="doc"><header class="doc-hero"><div class="muted">${escapeHtml(template.narrative.name)}</div><h1>${escapeHtml(ast.title)}</h1><p>${escapeHtml(template.narrative.summary)}</p></header>${sections}</main></div>`;
}

function renderDeck(state: RenderState, ast: DeckAst, template: TemplatePackage, includeNotes: boolean): string {
  const slides = ast.slides.map((slide, slideIndex) => {
    const layout = template.layouts.find((item) => item.id === slide.layout);
    if (layout === undefined) {
      state.issues.push({
        code: "LAYOUT_NOT_REGISTERED",
        nodeId: null,
        message: `版式未注册：${slide.layout}`,
      });
      return "";
    }
    const manual = isManualOutput(template);
    const blocksToRender = manual
      ? slide.blocks.map((block) => ({ ...block, slotId: "manual-content" }))
      : slide.blocks;
    const knownSlots = new Set(layout.slots.map((slot) => slot.id));
    for (const block of blocksToRender) {
      if (block.slotId === null || block.slotId === undefined || !knownSlots.has(block.slotId)) {
        state.issues.push({
          code: "UNPLACED_BLOCK",
          nodeId: block.id,
          message: `块 ${block.id} 未放置到版式 ${slide.layout}`,
        });
      }
    }
    return `<article class="slide layout-${escapeHtml(layout.id)}${manual ? " manual-slide" : ""}${slideIndex === 0 ? " is-active" : ""}" data-slide-index="${slideIndex}" aria-hidden="${slideIndex === 0 ? "false" : "true"}"><div class="slide-inner"><div class="slide-meta"><span>${escapeHtml(template.manifest.name)}</span><span>${String(slideIndex + 1).padStart(2, "0")}</span></div><h1 class="slide-title">${escapeHtml(slide.title)}</h1><div class="slide-content">${layout.slots
      .map((slot) => {
        const blocks = blocksToRender.filter((block) => block.slotId === slot.id);
        if (slot.required && blocks.length === 0) {
          state.issues.push({
            code: "REQUIRED_SLOT_EMPTY",
            nodeId: null,
            message: `必填槽位为空：${layout.id}/${slot.id}`,
          });
        }
        return `<div class="region region-${escapeHtml(slot.id)}" data-slot="${escapeHtml(slot.id)}">${blocks.map((block) => renderBlock(state, block)).join("")}</div>`;
      })
      .join("")}</div></div></article>${
      includeNotes && slide.speakerNotes.trim() !== ""
        ? `<aside class="notes" data-speaker-notes="${slideIndex}" hidden>${escapeHtml(slide.speakerNotes)}</aside>`
        : ""
    }`;
  }).join("");
  return `<div class="shell deck"><header class="capsule"><div><strong>${escapeHtml(ast.title)}</strong><small>${escapeHtml(template.manifest.name)} · 1600×900 · 离线演示</small></div><div class="nav"><button type="button" data-prev aria-label="上一页">←</button><span class="counter" data-count>01 / ${String(ast.slides.length).padStart(2, "0")}</span><button type="button" data-next aria-label="下一页">→</button><button type="button" data-fullscreen aria-label="全屏">⛶</button>${
    includeNotes ? `<button type="button" data-notes-toggle aria-label="讲稿">稿</button>` : ""
  }</div></header>${slides}</div>`;
}

function htmlDocument(input: {
  title: string;
  theme: Theme;
  body: string;
  script: string;
  includeNotes: boolean;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="generator" content="dcw-output-renderer/1">
  <title>${escapeHtml(input.title)}</title>
  <style>:root{${themeCss(input.theme)}}${BASE_CSS}</style>
</head>
<body data-notes-state="off" data-notes-included="${input.includeNotes ? "true" : "false"}">
${input.body}
<script>${input.script}</script>
</body>
</html>`;
}

export function renderProductionOutput(input: ProductionRenderInput): ProductionRenderResult {
  const state: RenderState = {
    media: input.media,
    resources: new Set<string>(),
    issues: [],
    staticized: [],
    mode: input.mode,
  };
  const body =
    input.ast.kind === "feishu_doc"
      ? renderDoc(state, input.ast, input.template, input.includeSpeakerNotes)
      : renderDeck(state, input.ast, input.template, input.includeSpeakerNotes);
  const html = htmlDocument({
    title: input.ast.title,
    theme: input.template.theme,
    body,
    script: input.ast.kind === "html_deck" ? DECK_SCRIPT : "",
    includeNotes: input.includeSpeakerNotes,
  });
  return {
    ok: state.issues.length === 0,
    html,
    resourcePaths: [...state.resources].sort(),
    issues: state.issues,
    staticized: state.staticized,
  };
}

export function blockMediaKeys(block: Block): string[] {
  switch (block.type) {
    case "image":
      return [imageKey(block)];
    case "video":
      return [`derivative:${block.posterDerivativeId}`, `asset_version:${block.assetVersionId}`];
    case "readonly_source_block":
      return block.previewDerivativeId === null ? [] : [`derivative:${block.previewDerivativeId}`];
    default:
      return [];
  }
}

export function astMediaKeys(ast: Ast): string[] {
  const keys = new Set<string>();
  const blocks = ast.kind === "feishu_doc"
    ? ast.sections.flatMap((section) => section.blocks)
    : ast.slides.flatMap((slide: Slide) => slide.blocks);
  for (const block of blocks) {
    for (const key of blockMediaKeys(block)) keys.add(key);
  }
  return [...keys].sort();
}

export const rendererVersion = "output-html-1";
