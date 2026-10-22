import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { TemplatePackageSchema } from "@dmall/contracts";
import { BlobStore } from "@dmall/storage";
import { buildBuiltinTemplatePackage, canonicalHash } from "@dmall/templates";
import { sha256 } from "../../../apps/server/src/authoring/revision-commit.js";
import type { KeywordIndexService } from "../../../apps/server/src/retrieval/index-service.js";

export const USER_FLOW_CREDENTIAL_ENV = "COMPOSER_USER_FLOW_KEY";
export const USER_FLOW_SOURCE_TITLE = "门店库存原文";
export const USER_FLOW_IMAGE_TITLE = "库存看板图片";
export const USER_FLOW_PARAGRAPH = "先盘点货架，再按缺口补货。";
export const USER_FLOW_CLOSING = "每周一核对库存";
export const USER_FLOW_IDEA = "为门店店长做一份库存核对演示，要求说明步骤并配看板图片。";

export interface UserFlowSeed {
  readonly merchantId: string;
  readonly templateVersionId: string;
  readonly sourceText: string;
  readonly imageBytes: Buffer;
  readonly imageSha256: string;
}

export interface ProviderCall {
  readonly phase: "intent" | "recommend" | "write_deck";
  readonly payload: Record<string, unknown>;
}

export interface UserFlowProvider {
  readonly baseUrl: string;
  readonly calls: readonly ProviderCall[];
  readonly seenRequests: number;
  count(phase?: ProviderCall["phase"]): number;
  close(): Promise<void>;
}

/**
 * Seeds one ready HTML template, one keyword document, and one local image.
 * The seed writes only fixture rows; business stages still run through the worker.
 */
export async function seedUserFlowFixture(input: {
  db: Database.Database;
  dataRoot: string;
  index: KeywordIndexService;
  providerBaseUrl: string;
  merchantId: string;
}): Promise<UserFlowSeed> {
  const { db, dataRoot, index } = input;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO provider_configs(id, role, base_url, model_id, capabilities_json, keychain_ref, created_at, updated_at) VALUES (?, 'text', ?, 'fixture-counted-model', ?, ?, ?, ?)")
    .run(randomUUID(), input.providerBaseUrl, JSON.stringify({ verified: true }), USER_FLOW_CREDENTIAL_ENV, now, now);

  const pkg = buildBuiltinTemplatePackage("training", "html_deck");
  pkg.manifest.id = randomUUID();
  pkg.manifest.templateVersionId = randomUUID();
  pkg.manifest.name = "库存培训演示";
  pkg.manifest.status = "ready";
  pkg.narrative.deck.slides = [
    { id: "detail", title: "库存三步核对", layout: "title-body-media", purpose: "说明库存核对步骤并展示看板图片。" },
    { id: "closing", title: "今日执行", layout: "closing", purpose: "收束到店长今天可以执行的动作。" },
  ];
  pkg.layouts = pkg.layouts.filter((layout) => layout.id === "title-body-media" || layout.id === "closing");
  pkg.slots = [
    { id: "detail-body", containerId: "detail", layoutSlotId: "body", order: 0, label: "正文", blockType: "paragraph", required: true,
      capacity: { maxCharacters: 180, maxItems: 1 }, source: { kind: "default", value: { kind: "text", text: "正文待补充" } } },
    { id: "detail-media", containerId: "detail", layoutSlotId: "media", order: 1, label: "证据图片", blockType: "image", required: false,
      capacity: { maxItems: 1 }, source: { kind: "material", mediaKind: "image" } },
    { id: "closing-next", containerId: "closing", layoutSlotId: "next", order: 0, label: "下一步", blockType: "list", required: true,
      capacity: { maxCharacters: 36, maxItems: 4 }, source: { kind: "default", value: { kind: "list", items: ["下一步待补充"] } } },
  ];
  const template = TemplatePackageSchema.parse(pkg);
  db.prepare("INSERT INTO templates(id, kind, name, created_at, updated_at) VALUES (?, 'html_deck', ?, ?, ?)")
    .run(template.manifest.id, template.manifest.name, now, now);
  db.prepare(`INSERT INTO template_versions(id, template_id, version, kind, narrative_json, layout_json, theme_json, capabilities_json, status, created_at, package_json, package_hash, slots_json, renderer_version)
    VALUES (?, ?, 1, 'html_deck', ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`)
    .run(template.manifest.templateVersionId, template.manifest.id, JSON.stringify(template.narrative), JSON.stringify(template.layouts),
      JSON.stringify(template.theme), JSON.stringify(template.capabilities), now, JSON.stringify(template), canonicalHash(template),
      JSON.stringify(template.slots), template.rendererVersion);

  const { merchantId } = input;
  const sourceText = "门店库存核对：每周盘点货架，缺货当日补货。";
  const sourceId = randomUUID();
  const sourceVersionId = randomUUID();
  const sectionId = randomUUID();
  const blobs = new BlobStore(dataRoot);
  const sourceBytes = Buffer.from(sourceText);
  const sourceHash = sha256(sourceText);
  await blobs.putBytes({ bytes: sourceBytes, expectedSha256: sourceHash, mime: "text/plain" });
  db.prepare("INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, 'text/plain', ?, ?)")
    .run(sourceHash, blobs.relativePathForHash(sourceHash), sourceBytes.length, now);

  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9XcAAAAASUVORK5CYII=", "base64");
  const image = await blobs.putBytes({ bytes: imageBytes, mime: "image/png" });
  db.prepare("INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, 'image/png', ?, ?)")
    .run(image.sha256, image.relativePath, image.bytes, now);

  db.prepare("INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at) VALUES (?, 'local', ?, ?, NULL, 'active', ?, ?)")
    .run(sourceId, `fixture:${sourceId}`, USER_FLOW_SOURCE_TITLE, now, now);
  db.prepare("INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sourceVersionId, sourceId, sourceHash, sourceHash, now, now);
  const locator = { kind: "block" as const, blockId: "inventory-steps" };
  db.prepare("INSERT INTO document_sections(id, source_version_id, adapter_id, ordinal, title, heading_path, text, locator_json, notes, created_at) VALUES (?, ?, 'steps', 1, '库存核对流程', '库存核对流程', ?, ?, '', ?)")
    .run(sectionId, sourceVersionId, sourceText, JSON.stringify(locator), now);
  index.insertDocumentChunks({
    sourceVersionId,
    drafts: [{ sectionAdapterId: "steps", chunkId: randomUUID(), chunkKind: "text", text: sourceText, title: "库存核对流程", tags: [], merchantId,
      mediaKind: "document", recordDate: null, effectiveFrom: null, effectiveTo: null, audience: [], functions: [], obsolete: false,
      availability: "available", locationKey: "steps", contentHash: sourceHash, blockAdapterIds: [], overlapChars: 0 }],
    sectionIdByAdapter: new Map([["steps", sectionId]]),
    blockIdByAdapter: new Map(),
    blockLocatorById: new Map(),
    sectionLocatorById: new Map([["steps", locator]]),
    now,
  });

  const assetId = randomUUID();
  const assetVersionId = randomUUID();
  const occurrenceId = randomUUID();
  const imageSourceId = randomUUID();
  const imageSourceVersionId = randomUUID();
  db.prepare("INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at) VALUES (?, 'local', ?, ?, NULL, 'active', ?, ?)")
    .run(imageSourceId, `fixture:${imageSourceId}`, USER_FLOW_IMAGE_TITLE, now, now);
  db.prepare("INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(imageSourceVersionId, imageSourceId, image.sha256, image.sha256, now, now);
  db.prepare("INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at) VALUES (?, ?, 'image', ?, ?)")
    .run(assetId, image.sha256, now, now);
  db.prepare("INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(assetVersionId, assetId, USER_FLOW_IMAGE_TITLE,
      JSON.stringify({ magicMime: "image/png", extensionMismatch: false, processorVersions: {}, probe: null }),
      JSON.stringify({ merchant: merchantId }), now);
  db.prepare(`INSERT INTO occurrences(id, source_version_id, asset_id, locator_json, occurrence_index,
    heading_path, before_text, after_text, media_status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, '库存看板', '', '', 'available', 0, ?, ?)`)
    .run(occurrenceId, imageSourceVersionId, assetId, JSON.stringify({ kind: "block", blockId: "inventory-board" }), now, now);
  index.rebuild();

  return { merchantId, templateVersionId: template.manifest.templateVersionId, sourceText, imageBytes, imageSha256: image.sha256 };
}

/**
 * A loopback OpenAI-compatible stand-in. It only exists for this test.
 * The phase is chosen from the fixed payload keys built by the server.
 */
export async function startUserFlowProvider(input: { merchantId: string }): Promise<UserFlowProvider> {
  const calls: ProviderCall[] = [];
  let seenRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      seenRequests += 1;
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        reply(response, 404, { error: { message: "fixture provider only serves POST /v1/chat/completions" } });
        return;
      }
      if (request.headers.authorization !== `Bearer fixture-only`) {
        reply(response, 401, { error: { message: "missing fixture bearer token" } });
        return;
      }
      const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })).min(2) })
        .parse(JSON.parse(await readBody(request)));
      const payload = z.object({ payload: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(body.messages[1]!.content)).payload;
      const phase = "proposal" in payload ? "write_deck" : "candidates" in payload ? "recommend" : "intent";
      calls.push({ phase, payload });
      const value = phase === "intent" ? intentValue(input.merchantId)
        : phase === "recommend" ? recommendationValue(payload)
          : deckValue(payload);
      reply(response, 200, { id: `fixture-${calls.length}`, choices: [{ message: { content: JSON.stringify(value) } }] });
    } catch (error) {
      reply(response, 500, { error: { message: error instanceof Error ? error.message : "fixture provider failed" } });
    }
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider port missing");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    get seenRequests() { return seenRequests; },
    count: (phase) => phase === undefined ? calls.length : calls.filter((call) => call.phase === phase).length,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function intentValue(merchantId: string): unknown {
  return {
    title: "库存三步核对",
    purpose: "帮助店长按固定步骤核对库存并补齐缺口",
    audience: "门店店长",
    constraints: ["只陈述已确认的门店库存流程"],
    merchantId,
    searchTerms: ["库存"],
    gaps: [],
  };
}

function recommendationValue(payload: Record<string, unknown>): unknown {
  const candidates = z.object({
    templates: z.array(z.object({ versionId: z.uuid() })).min(1),
    evidence: z.array(z.object({ evidenceId: z.uuid(), kind: z.string() })).min(1),
  }).parse(payload["candidates"]);
  const source = candidates.evidence.find((item) => item.kind === "source");
  const media = candidates.evidence.find((item) => item.kind === "media");
  if (source === undefined || media === undefined) throw new Error("fixture candidates need one source and one image");
  return {
    kind: "html_deck",
    title: "库存三步核对",
    templateVersionId: candidates.templates[0]!.versionId,
    reason: "现有培训模板可同时呈现步骤和看板图片",
    evidenceIds: candidates.evidence.map((item) => item.evidenceId),
    gaps: [],
    slides: [
      { key: "detail", title: "库存三步核对", intent: "说明核对步骤并展示看板图片", templateContainerKey: "detail", layoutKey: "title-body-media",
        placements: [
          { evidenceId: source.evidenceId, purpose: "支持库存步骤", position: "正文", use: "support", templateSlotKey: "detail-body" },
          { evidenceId: media.evidenceId, purpose: "展示门店看板", position: "右侧图片", use: "illustration", templateSlotKey: "detail-media" },
        ] },
      { key: "closing", title: "今日执行", intent: "给出店长今天可以执行的动作", templateContainerKey: "closing", layoutKey: "closing", placements: [] },
    ],
  };
}

function deckValue(payload: Record<string, unknown>): unknown {
  const proposal = z.object({
    title: z.string(),
    evidence: z.array(z.object({ id: z.uuid(), kind: z.string() })).min(1),
  }).parse(payload["proposal"]);
  const source = proposal.evidence.find((item) => item.kind === "source");
  const media = proposal.evidence.find((item) => item.kind === "media");
  if (source === undefined || media === undefined) throw new Error("fixture proposal needs one source and one image");
  return {
    kind: "html_deck",
    title: proposal.title,
    slides: [
      { key: "detail", title: "库存三步核对", speakerNotes: "先让店长看货架，再说明补货动作。",
        templateContainerKey: "detail", layoutKey: "title-body-media", parts: [
          { key: "body", kind: "paragraph", templateSlotKey: "detail-body", text: USER_FLOW_PARAGRAPH, sources: [source.id] },
          { key: "image", kind: "image", templateSlotKey: "detail-media", evidenceId: media.id, caption: "门店库存看板" },
        ] },
      { key: "closing", title: "今日执行", speakerNotes: "以每周一次核对作为起步。",
        templateContainerKey: "closing", layoutKey: "closing", parts: [
          { key: "next", kind: "list", templateSlotKey: "closing-next", items: [USER_FLOW_CLOSING, "缺货当日补货"], sources: [] },
        ] },
    ],
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "x-request-id": randomUUID() });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
