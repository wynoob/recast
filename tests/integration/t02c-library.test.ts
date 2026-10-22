import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssetPatchResultSchema,
  SourceListSchema,
  type SourceSummary,
} from "@dmall/contracts";
import { BlobStore } from "@dmall/storage";
import {
  startT02cApp,
  type T02cTestApp,
} from "./t02c-test-helpers.js";

describe("T02c source list, occurrence sourceId, origins, and posters", () => {
  let app: T02cTestApp;
  let sourceId: string;
  let sourceVersionId: string;
  let oldSourceVersionId: string;
  let videoAssetId: string;
  let posterHash: string;
  let previewHash: string;

  beforeAll(async () => {
    app = await startT02cApp();
    const db = app.context.database.db;
    const blobs = new BlobStore(app.config.dataRoot);
    const now = Date.now();
    const time = new Date(now).toISOString();
    const oldTime = new Date(now - 60_000).toISOString();

    sourceId = randomUUID();
    sourceVersionId = randomUUID();
    oldSourceVersionId = randomUUID();
    const secondSourceId = randomUUID();
    const localSourceId = randomUUID();
    const localVersionId = randomUUID();
    const snapshotHash = await putBlob(blobs, db, Buffer.from("# 来源\n"), "text/markdown", time);
    const localSnapshot = await putBlob(
      blobs,
      db,
      Buffer.from("local-file"),
      "application/octet-stream",
      time,
    );

    db.prepare(
      `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
       VALUES(?, 'local_markdown', 'source-one', '说明一', NULL, 'active', ?, ?)`,
    ).run(sourceId, new Date(now - 20_000).toISOString(), time);
    db.prepare(
      `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
       VALUES(?, 'local_markdown', 'source-two', '说明二', NULL, 'active', ?, ?)`,
    ).run(secondSourceId, new Date(now - 19_000).toISOString(), time);
    db.prepare(
      `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
       VALUES(?, 'local_file', 'local-file-root', '本地文件', NULL, 'active', ?, ?)`,
    ).run(localSourceId, time, time);
    db.prepare(
      `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
       VALUES(?, ?, ?, ?, NULL, ?, ?)`,
    ).run(oldSourceVersionId, sourceId, hashText("old-version"), snapshotHash, oldTime, oldTime);
    db.prepare(
      `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
       VALUES(?, ?, ?, ?, NULL, ?, ?)`,
    ).run(sourceVersionId, sourceId, hashText("current-version"), snapshotHash, time, time);
    db.prepare(
      `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
       VALUES(?, ?, ?, ?, NULL, ?, ?)`,
    ).run(localVersionId, localSourceId, hashText("local-version"), localSnapshot, time, time);

    for (let index = 0; index < 100; index += 1) {
      const bytes = Buffer.from(`fake-asset-${index}`);
      const blobHash = await putBlob(blobs, db, bytes, "image/png", time);
      const assetId = randomUUID();
      db.prepare(
        `INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at)
         VALUES(?, ?, 'image', ?, ?)`,
      ).run(assetId, blobHash, time, time);
      db.prepare(
        `INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at)
         VALUES(?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        randomUUID(),
        assetId,
        `假素材 ${index}`,
        JSON.stringify({
          magicMime: "image/png",
          extensionMismatch: false,
          processorVersions: {},
          probe: { kind: "image", width: 1, height: 1, format: "png", hasAlpha: true },
        }),
        JSON.stringify({
          title: `假素材 ${index}`,
          tags: [],
          origins: { title: "source", tags: "source" },
          merchant: null,
        }),
        time,
      );
      insertOccurrence(db, {
        sourceVersionId: localVersionId,
        assetId,
        relativePath: `fake/${index}.png`,
        positionKey: `fake-${index}`,
        time,
        mediaStatus: "available",
      });
    }

    const originalHash = await putBlob(
      blobs,
      db,
      Buffer.from("fake-video-original"),
      "video/mp4",
      time,
    );
    posterHash = await putBlob(
      blobs,
      db,
      await sharp({
        create: { width: 4, height: 3, channels: 4, background: "#7c4dff" },
      })
        .webp()
        .toBuffer(),
      "image/webp",
      time,
    );
    previewHash = await putBlob(
      blobs,
      db,
      Buffer.from("fake-video-preview"),
      "video/mp4",
      time,
    );
    const failedPosterHash = await putBlob(
      blobs,
      db,
      Buffer.from("failed-poster"),
      "image/webp",
      time,
    );
    videoAssetId = randomUUID();
    db.prepare(
      `INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at)
       VALUES(?, ?, 'video', ?, ?)`,
    ).run(videoAssetId, originalHash, time, time);
    db.prepare(
      `INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at)
       VALUES(?, ?, '视频素材', ?, ?, 0, ?)`,
    ).run(
      randomUUID(),
      videoAssetId,
      JSON.stringify({
        magicMime: "video/mp4",
        extensionMismatch: false,
        processorVersions: { ffprobe: "ffprobe/8.1" },
        probe: {
          kind: "video",
          durationMs: 1_000,
          width: 4,
          height: 3,
          videoCodec: "h264",
          fps: 30,
          audioCodec: null,
          frameCount: 30,
        },
      }),
      JSON.stringify({
        title: "视频素材",
        tags: [],
        origins: { title: "source", tags: "source" },
        merchant: "Dmall",
      }),
      time,
    );
    db.prepare(
      `INSERT INTO derivatives(id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at)
       VALUES(?, ?, 'poster', '{}', ?, ?, 'ready', ?)`,
    ).run(randomUUID(), videoAssetId, hashText("poster-recipe"), posterHash, time);
    db.prepare(
      `INSERT INTO derivatives(id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at)
       VALUES(?, ?, 'video_preview', '{}', ?, ?, 'ready', ?)`,
    ).run(randomUUID(), videoAssetId, hashText("preview-recipe"), previewHash, time);
    db.prepare(
      `INSERT INTO derivatives(id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at)
       VALUES(?, ?, 'poster', '{}', ?, ?, 'failed', ?)`,
    ).run(
      randomUUID(),
      videoAssetId,
      hashText("failed-poster-recipe"),
      failedPosterHash,
      new Date(now + 1_000).toISOString(),
    );
    insertOccurrence(db, {
      sourceVersionId,
      assetId: videoAssetId,
      relativePath: "video.mp4",
      positionKey: "video-current",
      time,
      mediaStatus: "available",
    });
    insertOccurrence(db, {
      sourceVersionId,
      assetId: null,
      relativePath: "missing.png",
      positionKey: "missing-current",
      time,
      mediaStatus: "missing",
    });
    insertOccurrence(db, {
      sourceVersionId: oldSourceVersionId,
      assetId: null,
      relativePath: "old-missing.png",
      positionKey: "old-missing",
      time,
      mediaStatus: "missing",
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("returns only the two real Markdown sources with current-version counts", async () => {
    const first = SourceListSchema.parse(
      ((await app.getJson("/api/v1/sources?kind=local_markdown&limit=1")) as { data: unknown }).data,
    );
    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("1");
    const second = SourceListSchema.parse(
      ((await app.getJson("/api/v1/sources?kind=local_markdown&limit=1&cursor=1")) as {
        data: unknown;
      }).data,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const items = [...first.items, ...second.items];
    expect(items.map((item) => item.title).sort()).toEqual(["说明一", "说明二"]);
    const source: SourceSummary | undefined = items.find((item) => item.id === sourceId);
    expect(source).toMatchObject({
      currentVersionId: sourceVersionId,
      occurrenceCount: 2,
      missingOccurrenceCount: 1,
      linkedAssetCount: 1,
    });
    expect(items.find((item) => item.id !== sourceId)).toMatchObject({
      currentVersionId: null,
      occurrenceCount: 0,
      linkedAssetCount: 0,
    });
    expect(items).not.toHaveLength(100);
    const invalid = await fetch(`${app.base}/api/v1/sources?kind=local_markdown&cursor=bad`, {
      headers: { cookie: app.cookie },
    });
    expect(invalid.status).toBe(422);
  });

  it("maps occurrence sourceId, summary origins, and a real WebP poster", async () => {
    const detail = (await app.getJson(`/api/v1/assets/${videoAssetId}`)) as {
      data: {
        summary: {
          posterFileUrl: string | null;
          previewFileUrl: string | null;
          origins: { title: string; tags: string };
        };
        humanFields: { origins: { title: string; tags: string } };
        occurrences: { sourceId: string; sourceVersionId: string }[];
        sourceSuggestion: unknown;
      };
    };
    expect(detail.data.summary.posterFileUrl).toBe(`/api/v1/files/${posterHash}`);
    expect(detail.data.summary.previewFileUrl).toBe(`/api/v1/files/${previewHash}`);
    expect(detail.data.summary.posterFileUrl).not.toBe(detail.data.summary.previewFileUrl);
    expect(detail.data.summary.origins).toEqual(detail.data.humanFields.origins);
    expect(detail.data.occurrences[0]).toMatchObject({
      sourceId,
      sourceVersionId,
    });
    const sourceContext = (await app.getJson(
      `/api/v1/sources/${detail.data.occurrences[0]?.sourceId}?versionId=${detail.data.occurrences[0]?.sourceVersionId}`,
    )) as { data: { source: { id: string }; version: { id: string } } };
    expect(sourceContext.data.source.id).toBe(sourceId);
    expect(sourceContext.data.version.id).toBe(sourceVersionId);
    expect(detail.data.sourceSuggestion).toBeNull();

    const posterResponse = await fetch(`${app.base}${detail.data.summary.posterFileUrl}`, {
      headers: { cookie: app.cookie },
    });
    expect(posterResponse.status).toBe(200);
    expect(posterResponse.headers.get("content-type")).toContain("image/webp");
    const metadata = await sharp(Buffer.from(await posterResponse.arrayBuffer())).metadata();
    expect(metadata.format).toBe("webp");

    const list = (await app.getJson("/api/v1/assets?type=video&limit=100")) as {
      data: {
        items: {
          id: string;
          posterFileUrl: string | null;
          origins: { title: string; tags: string };
        }[];
      };
    };
    const listed = list.data.items.find((item) => item.id === videoAssetId);
    expect(listed).toMatchObject({
      posterFileUrl: `/api/v1/files/${posterHash}`,
      origins: { title: "source", tags: "source" },
    });
  });

  it("applies PATCH once through the shared result schema and updates summary origins", async () => {
    const body = {
      schemaVersion: 1,
      expectedVersion: 0,
      title: "人工视频标题",
      tags: ["人工"],
    };
    const key = randomUUID();
    const first = (await app.writeJson("PATCH", `/api/v1/assets/${videoAssetId}`, body, key)) as {
      data: unknown;
    };
    expect(AssetPatchResultSchema.parse(first.data)).toMatchObject({
      version: 1,
      title: "人工视频标题",
      origins: { title: "manual", tags: "manual" },
    });
    const replay = (await app.writeJson("PATCH", `/api/v1/assets/${videoAssetId}`, body, key)) as {
      data: unknown;
    };
    expect(replay).toEqual(first);
    const list = (await app.getJson("/api/v1/assets?type=video&limit=100")) as {
      data: {
        items: {
          id: string;
          origins: { title: string; tags: string };
        }[];
      };
    };
    expect(list.data.items.find((item) => item.id === videoAssetId)?.origins).toEqual({
      title: "manual",
      tags: "manual",
    });
    const detail = (await app.getJson(`/api/v1/assets/${videoAssetId}`)) as {
      data: { humanFields: { origins: { title: string; tags: string } } };
    };
    expect(detail.data.humanFields.origins).toEqual({ title: "manual", tags: "manual" });
  });

  it("drops a poster URL when the ready poster blob is absent", async () => {
    await unlink(join(app.config.dataRoot, "blobs/sha256", posterHash.slice(0, 2), posterHash));
    const detail = (await app.getJson(`/api/v1/assets/${videoAssetId}`)) as {
      data: { summary: { posterFileUrl: string | null; availability: string } };
    };
    expect(detail.data.summary.posterFileUrl).toBeNull();
    expect(detail.data.summary.availability).toBe("missing");
  });

  it("returns the truthful integrated settings state", async () => {
    const settings = (await app.getJson("/api/v1/settings")) as {
      data: { features: { localImport: string } };
    };
    expect(settings.data.features.localImport).toBe("implemented_pending_acceptance");
    expect(JSON.stringify(settings)).not.toContain("T02 验收");
  });
});

async function putBlob(
  blobs: BlobStore,
  db: T02cTestApp["context"]["database"]["db"],
  bytes: Buffer,
  mime: string,
  createdAt: string,
): Promise<string> {
  const stored = await blobs.putBytes({ bytes, mime });
  db.prepare(
    "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING",
  ).run(stored.sha256, stored.relativePath, mime, stored.bytes, createdAt);
  return stored.sha256;
}

function insertOccurrence(
  db: T02cTestApp["context"]["database"]["db"],
  input: {
    sourceVersionId: string;
    assetId: string | null;
    relativePath: string;
    positionKey: string;
    time: string;
    mediaStatus: "available" | "missing" | "unsupported";
  },
): void {
  db.prepare(
    `INSERT INTO occurrences(id, source_version_id, asset_id, locator_json, position_key,
      occurrence_index, heading_path, before_text, after_text, media_status, media_error_code,
      version, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, 0, '', '', '', ?, ?, 0, ?, ?)`,
  ).run(
    randomUUID(),
    input.sourceVersionId,
    input.assetId,
    JSON.stringify({
      schemaVersion: 1,
      kind: "local_file",
      relativePath: input.relativePath,
    }),
    input.positionKey,
    input.mediaStatus,
    input.mediaStatus === "missing" ? "MISSING_DEPENDENCY" : null,
    input.time,
    input.time,
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
