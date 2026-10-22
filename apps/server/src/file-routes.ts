import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { BlobStore } from "@dmall/storage";
import { ApiError } from "./errors.js";

const HashParamsSchema = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export function registerFileRoutes(input: {
  app: FastifyInstance;
  blobs: BlobStore;
  db: Database.Database;
}): void {
  input.app.route({
    method: ["GET", "HEAD"],
    url: "/api/v1/files/:hash",
    handler: async (request, reply) => {
      await sendFile(request, reply, input.blobs, input.db);
    },
  });
}

async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  blobs: BlobStore,
  db: Database.Database,
): Promise<FastifyReply> {
  const { hash } = HashParamsSchema.parse(request.params);
  const descriptor = await blobs.describe(hash);
  if (descriptor === null) {
    throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "文件不存在" });
  }
  const row = z
    .strictObject({ mime: z.string().min(1), bytes: z.int().nonnegative() })
    .parse(db.prepare("SELECT mime, bytes FROM blobs WHERE sha256 = ?").get(hash));
  if (row.bytes !== descriptor.bytes) {
    throw new ApiError({
      statusCode: 409,
      code: "SOURCE_UNREADABLE",
      message: "文件字节数与数据库记录不一致",
    });
  }
  const etag = `"${hash}"`;
  const size = row.bytes;
  reply.header("Accept-Ranges", "bytes");
  reply.header("ETag", etag);
  reply.header("Cache-Control", "private, max-age=31536000, immutable");
  reply.header("X-Content-Type-Options", "nosniff");
  if (row.mime === "text/html" || row.mime === "image/svg+xml") {
    reply.header(
      "Content-Security-Policy",
      "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    );
  }
  reply.header("Content-Type", row.mime);
  if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }
  const ifRange = request.headers["if-range"];
  const rangeHeader =
    ifRange === undefined || ifRange === etag ? request.headers.range : undefined;
  const range = rangeHeader === undefined ? null : parseRange(rangeHeader, size);
  if (range === "invalid") {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).send();
  }
  if (range === null) {
    reply.header("Content-Length", String(size));
    if (request.method === "HEAD") return reply.code(200).send();
    return reply.code(200).send(createReadStream(blobs.pathForHash(hash)));
  }
  reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  reply.header("Content-Length", String(range.end - range.start + 1));
  if (request.method === "HEAD") return reply.code(206).send();
  return reply
    .code(206)
    .send(createReadStream(blobs.pathForHash(hash), { start: range.start, end: range.end }));
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header.startsWith("bytes=")) return "invalid";
  const value = header.slice("bytes=".length).trim();
  if (value === "" || value.includes(",")) return "invalid";
  const match = /^(\d*)-(\d*)$/u.exec(value);
  if (match === null) return "invalid";
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return "invalid";
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return "invalid";
  const end = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isSafeInteger(end) || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag || value === "*" || value === `W/${etag}`);
}
