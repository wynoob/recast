import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  builtinNarratives,
  createSyntheticSample,
  renderTemplateSample,
} from "../dist/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examples = path.join(root, "examples");
const assets = path.join(examples, "assets");

const syntheticFlow = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241c50"/>
      <stop offset="0.55" stop-color="#3b2a7a"/>
      <stop offset="1" stop-color="#0d0b1f"/>
    </linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="#8b72ff" stroke-opacity=".18"/>
    </pattern>
  </defs>
  <rect width="1600" height="900" fill="url(#g)"/>
  <rect width="1600" height="900" fill="url(#grid)"/>
  <circle cx="1270" cy="200" r="260" fill="#6d3fe0" fill-opacity=".28"/>
  <rect x="120" y="126" width="260" height="40" rx="20" fill="#6d3fe0" fill-opacity=".55"/>
  <text x="120" y="300" fill="#f7f4ff" font-family="PingFang SC, sans-serif" font-size="72" font-weight="700">合成示意媒体 A</text>
  <text x="120" y="370" fill="#c9c2e8" font-family="PingFang SC, sans-serif" font-size="28">流程占位图 · 非真实材料</text>
  <g fill="#30256a" stroke="#7560c8">
    <rect x="120" y="470" width="360" height="170" rx="24"/>
    <rect x="560" y="470" width="360" height="170" rx="24"/>
    <rect x="1000" y="470" width="360" height="170" rx="24"/>
  </g>
  <g fill="#f7f4ff" font-family="PingFang SC, sans-serif" font-size="28">
    <text x="165" y="540">01 收集</text>
    <text x="605" y="540">02 核对</text>
    <text x="1045" y="540">03 输出</text>
  </g>
  <g fill="#c9c2e8" font-family="PingFang SC, sans-serif" font-size="20">
    <text x="165" y="585">显式来源</text>
    <text x="605" y="585">事实版本</text>
    <text x="1045" y="585">人工验收</text>
  </g>
  <text x="120" y="820" fill="#f3bf68" font-family="PingFang SC, sans-serif" font-size="22">SYNTHETIC / 合成示意</text>
</svg>`;

const syntheticEvidence = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#0d0b1f"/>
      <stop offset="1" stop-color="#30256a"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#g)"/>
  <g stroke="#7560c8" stroke-opacity=".35">
    <path d="M120 720H1480M120 600H1480M120 480H1480M120 360H1480"/>
  </g>
  <polyline points="150,690 370,610 590,640 810,430 1030,470 1250,290 1450,330" fill="none" stroke="#5ee0a8" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="#6d3fe0" stroke="#f7f4ff" stroke-width="5">
    <circle cx="370" cy="610" r="16"/><circle cx="810" cy="430" r="16"/><circle cx="1250" cy="290" r="16"/>
  </g>
  <text x="120" y="150" fill="#f7f4ff" font-family="PingFang SC, sans-serif" font-size="64" font-weight="700">合成示意媒体 B</text>
  <text x="120" y="210" fill="#c9c2e8" font-family="PingFang SC, sans-serif" font-size="26">趋势占位图 · 数值不可用于业务判断</text>
  <text x="120" y="820" fill="#f3bf68" font-family="PingFang SC, sans-serif" font-size="22">SYNTHETIC / 合成示意</text>
</svg>`;

const syntheticCompare = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <rect width="1600" height="900" fill="#0d0b1f"/>
  <g>
    <rect x="90" y="120" width="660" height="660" rx="32" fill="#241c50" stroke="#7560c8"/>
    <rect x="850" y="120" width="660" height="660" rx="32" fill="#30256a" stroke="#8b72ff"/>
    <circle cx="300" cy="330" r="110" fill="#7560c8" fill-opacity=".32"/>
    <circle cx="1060" cy="330" r="110" fill="#5ee0a8" fill-opacity=".24"/>
    <text x="150" y="520" fill="#f7f4ff" font-family="PingFang SC, sans-serif" font-size="42" font-weight="700">现状</text>
    <text x="910" y="520" fill="#f7f4ff" font-family="PingFang SC, sans-serif" font-size="42" font-weight="700">目标</text>
    <text x="150" y="580" fill="#c9c2e8" font-family="PingFang SC, sans-serif" font-size="24">合成示意对照</text>
    <text x="910" y="580" fill="#c9c2e8" font-family="PingFang SC, sans-serif" font-size="24">合成示意对照</text>
  </g>
  <text x="90" y="850" fill="#f3bf68" font-family="PingFang SC, sans-serif" font-size="22">SYNTHETIC / 合成示意</text>
</svg>`;

function galleryHtml(entries) {
  const cards = entries
    .map(
      (entry) => `<article class="card">
        <div class="card-head">
          <span class="kind">${entry.kind === "feishu_doc" ? "飞书文档" : "HTML 演示"}</span>
          <span class="status">draft · 待 ready review</span>
        </div>
        <h3>${entry.label}</h3>
        <p>${entry.summary}</p>
        <div class="meta"><code>${entry.artifactId}</code><span>${entry.artifactHash.slice(0, 12)}</span></div>
        <a class="open" href="${entry.file}">打开样例 →</a>
      </article>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>T05 模板引擎样例 · 合成示意</title>
  <style>
    :root{--bg:#0d0b1f;--bg2:#171238;--surface:#241c50;--text:#f7f4ff;--muted:#c9c2e8;--accent:#6d3fe0;--border:#7560c8;--warning:#f3bf68}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;color:var(--text);font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
      background:radial-gradient(circle at 8% 0%,#3b2a7a,transparent 36rem),radial-gradient(circle at 92% 24%,#173d38,transparent 30rem),linear-gradient(145deg,var(--bg),var(--bg2) 62%,var(--bg))}
    .page{max-width:1440px;margin:0 auto;padding:36px 26px 60px}
    .nav{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 18px;border:1px solid #7560c8b8;border-radius:999px;background:#241c50b8;backdrop-filter:blur(18px)}
    .brand{font-weight:800;letter-spacing:.02em}.brand span{color:var(--warning);font-weight:600;font-size:12px;margin-left:10px}
    .nav-links{display:flex;gap:8px}.nav-links a{color:var(--muted);text-decoration:none;padding:8px 14px;border-radius:999px}
    .nav-links a:first-child{background:#6d3fe0;color:#fff}
    header.hero{padding:72px 4px 42px;max-width:980px}
    .flag{display:inline-flex;padding:7px 12px;border:1px solid #f3bf6899;border-radius:999px;color:var(--warning);font-size:12px;letter-spacing:.05em}
    h1{font-size:clamp(38px,6vw,76px);line-height:1.06;letter-spacing:-.045em;margin:20px 0 18px;max-width:13em}
    .hero p{font-size:18px;line-height:1.7;color:var(--muted);max-width:46em;margin:0}
    .stats{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.stat{padding:10px 14px;border:1px solid #7560c866;border-radius:12px;background:#241c5099;font-size:13px;color:var(--muted)}
    .section-title{display:flex;justify-content:space-between;align-items:end;margin:34px 0 18px}.section-title h2{font-size:26px;margin:0}.section-title span{color:var(--muted);font-size:13px}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
    .card{padding:24px;border-radius:24px;border:1px solid #7560c899;background:#241c50c2;backdrop-filter:blur(18px);box-shadow:0 22px 70px #03021248;display:flex;flex-direction:column;min-height:310px}
    .card-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.kind{color:var(--text);font-size:12px;font-weight:700}.status{color:var(--warning);font-size:11px}
    .card h3{font-size:25px;margin:34px 0 12px;letter-spacing:-.02em}.card p{color:var(--muted);line-height:1.6;margin:0;font-size:14px}
    .meta{margin-top:auto;padding-top:20px;display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:11px}.meta code{font-family:"SFMono-Regular",Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:65%}
    .open{margin-top:14px;display:flex;justify-content:center;padding:12px 16px;border-radius:12px;background:linear-gradient(135deg,#7b4df0,#5630ba);color:#fff;text-decoration:none;font-weight:700;font-size:14px;border:1px solid #a18cff66}
    .negative{margin-top:34px;padding:24px;border-radius:24px;border:1px dashed #f3bf6899;background:#241c5077}.negative h2{font-size:20px;margin:0 0 10px}.negative a{color:var(--warning)}
    footer{margin-top:46px;color:var(--muted);font-size:12px;line-height:1.8}
    @media(max-width:1020px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:700px){.page{padding:16px}.nav-links a:nth-child(2),.nav-links a:nth-child(3){display:none}.grid{grid-template-columns:1fr}header.hero{padding:48px 0 28px}.card{min-height:270px}}
  </style>
</head>
<body><main class="page">
  <nav class="nav"><div class="brand">Dmall 内容工作台<span>T05 模块样例</span></div><div class="nav-links"><a href="index.html">模板样例</a><a href="deck-product-intro.html">八版式</a><a href="doc-phase-review.html">文档</a></div></nav>
  <header class="hero">
    <div class="flag">合成示意 · 非真实材料 · 未接 DB/API/飞书</div>
    <h1>六种叙事，两种输出，一套受控结构。</h1>
    <p>这些页面由 T05 模板引擎生成。文档和演示共用叙事定义，演示使用 8 种受控版式与 1600×900 画布。所有图片与事实均为本地合成示意。</p>
    <div class="stats"><span class="stat">6 叙事 × 2 格式</span><span class="stat">8 受控 layout</span><span class="stat">violet / glass / 24px</span><span class="stat">ready 状态尚未入库</span></div>
  </header>
  <div class="section-title"><h2>可加载样例</h2><span>直接打开 HTML，无 CDN、无远程字体</span></div>
  <section class="grid">${cards}</section>
  <section class="negative"><h2>故障负例</h2><p><a href="negative-overflow.html">打印溢出样例</a> 与 <a href="negative-missing.html">缺媒体样例</a> 仅用于验证检测器，不是可用模板。</p></section>
  <footer>T05 模板引擎模块样例。ready review 需真实 Chromium 证据；HTML/PDF 完整导出闭包与飞书发布仍属于 T07。</footer>
</main></body></html>`;
}

async function main() {
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, "synthetic-flow.svg"), syntheticFlow);
  await fs.writeFile(path.join(assets, "synthetic-evidence.svg"), syntheticEvidence);
  await fs.writeFile(path.join(assets, "synthetic-compare.svg"), syntheticCompare);

  const entries = [];
  const summaries = new Map(
    builtinNarratives.map((item) => [item.id, item.summary]),
  );
  for (const narrative of builtinNarratives) {
    for (const kind of ["feishu_doc", "html_deck"]) {
      const sample = createSyntheticSample(narrative.id, kind);
      const render = renderTemplateSample({
        instance: sample.instance,
        media: sample.mediaPaths,
      });
      if (!render.ok) {
        throw new Error(
          `${narrative.id}/${kind} 渲染失败: ${render.issues
            .map((item) => item.message)
            .join("；")}`,
        );
      }
      const file = `${kind === "feishu_doc" ? "doc" : "deck"}-${narrative.id}.html`;
      await fs.writeFile(path.join(examples, file), render.html, "utf8");
      entries.push({
        artifactId: `${kind}:${narrative.id}`,
        kind,
        narrativeId: narrative.id,
        label: `${narrative.name}${kind === "feishu_doc" ? "文档" : "演示"}`,
        summary: summaries.get(narrative.id) ?? "",
        file,
        artifactHash: render.artifactHash,
        rendererVersion: sample.packageValue.rendererVersion,
        templateVersionId: sample.packageValue.manifest.templateVersionId,
        resourcePaths: render.resourcePaths,
      });
    }
  }

  const gallery = galleryHtml(entries);
  await fs.writeFile(path.join(examples, "index.html"), gallery, "utf8");

  const overflowSample = createSyntheticSample("product-intro", "html_deck");
  const overflowInstance = structuredClone(overflowSample.instance);
  if (overflowInstance.ast.kind === "html_deck") {
    const cover = overflowInstance.ast.slides[0];
    const subtitle = cover?.blocks.find((block) => block.type === "paragraph");
    if (subtitle?.type === "paragraph") {
      subtitle.inlines = [
        {
          text: "打印溢出负例：".repeat(120),
          marks: [],
        },
      ];
    }
  }
  const overflowRender = renderTemplateSample({
    instance: overflowInstance,
    media: overflowSample.mediaPaths,
  });
  await fs.writeFile(
    path.join(examples, "negative-overflow.html"),
    overflowRender.html,
    "utf8",
  );

  const missingMedia = {
    ...overflowSample.mediaPaths,
    [`derivative:${overflowSample.materials[0]?.kind === "image" ? overflowSample.materials[0].derivativeId : ""}`]:
      "assets/does-not-exist.svg",
  };
  const missingRender = renderTemplateSample({
    instance: overflowSample.instance,
    media: missingMedia,
  });
  await fs.writeFile(
    path.join(examples, "negative-missing.html"),
    missingRender.html,
    "utf8",
  );

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sampleDataLabel: "合成示意 · 非真实材料",
    entries,
    negatives: {
      overflow: {
        file: "negative-overflow.html",
        expected: "print overflow detected",
      },
      missing: {
        file: "negative-missing.html",
        expected: "missing resource detected",
      },
    },
  };
  await fs.writeFile(
    path.join(examples, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `generated ${entries.length} template samples, gallery, assets and 2 negative pages`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
