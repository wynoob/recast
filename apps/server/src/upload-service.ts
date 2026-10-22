import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { SafeRelativePathSchema, UploadChunkResultSchema, type UploadChunkResult, } from "@dmall/contracts";
import type Database from "better-sqlite3";
import { decodeUtf8Sample } from "@dmall/storage";
import { sniffMagic } from "@dmall/domain";
import { ApiError } from "./errors.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type { ImportRepository, UploadSessionRecord } from "./import-repository.js";
import type { WriteContext } from "./import-service.js";
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BUFFER = 1024 * 1024;
const FieldsSchema = z.strictObject({
  fileId: z.uuid().optional(),
  relativePath: SafeRelativePathSchema.optional(),
  declaredBytes: z.coerce.number().int().nonnegative().max(MAX_FILE_BYTES).optional(),
  chunkIndex: z.coerce.number().int().nonnegative(),
  chunkCount: z.coerce.number().int().min(1).max(65536),
  chunkSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type Fields = z.infer<typeof FieldsSchema>;
type Seed = Parameters<ImportRepository["insertUploadSession"]>[0];
export class UploadService {
  private readonly dataRoot: string;
  private readonly uploadsRoot: string;
  private readonly imports: ImportRepository;
  private readonly idempotency: IdempotencyRepository;
  private readonly db: Database.Database;
  private serial: Promise<void> = Promise.resolve();
  constructor(input: {
    dataRoot: string;
    imports: ImportRepository;
    idempotency: IdempotencyRepository;
    db: Database.Database;
  }) {
    this.dataRoot = resolve(input.dataRoot);
    this.uploadsRoot = join(this.dataRoot, "staging", "uploads");
    this.imports = input.imports;
    this.idempotency = input.idempotency;
    this.db = input.db;
  }
  async upload(request: FastifyRequest, context: WriteContext): Promise<UploadChunkResult> {
    const previous = this.serial;
    let release = () => { };
    this.serial = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.receive(request, context);
    }
    finally {
      release();
    }
  }
  private async receive(request: FastifyRequest, context: WriteContext): Promise<UploadChunkResult> {
    if (!request.isMultipart())
      throw new ApiError({ statusCode: 415, code: "VALIDATION_ERROR", message: "上传必须使用 multipart/form-data" });
    await mkdir(this.uploadsRoot, { recursive: true });
    const temporaryPath = join(this.uploadsRoot, `incoming-${randomUUID()}.part`);
    const fields: Record<string, string> = {};
    let received: {
      parsed: Fields;
      streamed: {
        sha256: string;
        bytes: number;
      };
      session: UploadSessionRecord | null;
      seed: Seed | null;
    } | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") {
          if (received !== null)
            throw validation("分块元数据必须放在文件字段之前");
          if (Object.keys(fields).length >= 16)
            throw validation("multipart 字段过多");
          fields[part.fieldname] = String(part.value);
          continue;
        }
        if (received !== null) {
          part.file.resume();
          throw validation("每次请求只能包含一个文件分块");
        }
        const parsed = FieldsSchema.parse(fields);
        if (parsed.chunkIndex >= parsed.chunkCount)
          throw validation("分块序号超出范围");
        const session = parsed.fileId === undefined ? null : this.imports.requireUploadSession(parsed.fileId);
        const seed = session === null ? this.sessionSeed(parsed, context) : null;
        if (session !== null && session.chunkCount !== parsed.chunkCount)
          throw uploadOrderInvalid("分块总数与上传会话不一致");
        const existing = session === null ? null : this.imports.uploadChunk(session.id, parsed.chunkIndex);
        if (existing !== null && existing.sha256 !== parsed.chunkSha256)
          throw uploadOrderInvalid("分块内容与已保存分块不一致");
        if (existing === null && session !== null && (session.status !== "uploading" || session.nextChunk !== parsed.chunkIndex))
          throw uploadOrderInvalid("分块顺序或上传会话状态不正确");
        const remaining = existing === null ? Math.min(MAX_FILE_BYTES, session?.declaredBytes ?? seed?.declaredBytes ?? 0) - (session?.receivedBytes ?? 0) : existing.bytes;
        const streamed = await streamToFile(part.file, temporaryPath, Math.min(MAX_CHUNK_BYTES, remaining));
        received = { parsed, streamed, session, seed };
      }
      if (received === null)
        throw validation("缺少文件分块");
      const { parsed, streamed, session, seed } = received;
      if (streamed.sha256 !== parsed.chunkSha256)
        throw new ApiError({ statusCode: 422, code: "CHUNK_HASH_MISMATCH", message: "分块 SHA-256 不匹配" });
      const requestHash = this.idempotency.requestHash(parsed);
      const receipt = this.idempotency.find(context.scope, context.key);
      if (receipt !== null) {
        if (receipt.requestHash !== requestHash)
          throw idempotencyConflict();
        return parseUploadResponse(receipt.response);
      }
      const id = session?.id ?? seed?.id;
      if (id === undefined)
        throw validation("缺少上传身份");
      const prior = this.imports.uploadChunk(id, parsed.chunkIndex);
      const destination = join(this.uploadsRoot, id, "chunks", `${String(parsed.chunkIndex).padStart(6, "0")}-${streamed.sha256}.part`);
      await mkdir(dirname(destination), { recursive: true });
      await this.moveIntoPlace(temporaryPath, destination, streamed.sha256, streamed.bytes);
      const chunk = { session_id: id, chunk_index: parsed.chunkIndex, sha256: streamed.sha256, bytes: streamed.bytes, relative_path: this.relativeToDataRoot(destination) };
      const total = (session?.receivedBytes ?? 0) + (prior === null ? streamed.bytes : 0);
      const nextChunk = (session?.nextChunk ?? 0) + (prior === null ? 1 : 0);
      const declared = session?.declaredBytes ?? seed?.declaredBytes ?? 0;
      if (total > Math.min(MAX_FILE_BYTES, declared))
        throw capacity();
      let result: UploadChunkResult;
      if (nextChunk === parsed.chunkCount) {
        const chunks = this.imports.uploadChunks(id);
        if (prior === null)
          chunks.push(chunk);
        result = await this.assemble({ id, relativePath: session?.relativePath ?? seed?.relativePath ?? "", declaredBytes: declared, chunkCount: parsed.chunkCount }, chunks);
      }
      else {
        result = { fileId: id, receivedBytes: total, nextChunk, complete: false, sha256: null, bytes: null, mime: null, magicKind: null };
      }
      return this.db.transaction(() => {
        const saved = this.idempotency.find(context.scope, context.key);
        if (saved !== null) {
          if (saved.requestHash !== requestHash)
            throw idempotencyConflict();
          return parseUploadResponse(saved.response);
        }
        if (seed !== null)
          this.imports.insertUploadSession(seed);
        const updated = this.imports.recordUploadChunk({ sessionId: id, index: parsed.chunkIndex, sha256: streamed.sha256, bytes: streamed.bytes, relativePath: chunk.relative_path });
        if (updated.receivedBytes !== total || updated.nextChunk !== nextChunk)
          throw uploadOrderInvalid("上传状态已变化");
        if (result.complete && result.sha256 !== null && result.bytes !== null && result.mime !== null) {
          this.imports.completeUploadSession({ id, sha256: result.sha256, bytes: result.bytes, mime: result.mime, assembledRelativePath: this.relativeToDataRoot(join(this.uploadsRoot, id, "file")) });
        }
        this.idempotency.save({ routeScope: context.scope, key: context.key, requestHash, statusCode: 201, requestId: context.requestId, response: { data: result, requestId: context.requestId }, resultRef: id });
        return result;
      })();
    }
    finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
  private sessionSeed(parsed: Fields, context: WriteContext): Seed {
    if (parsed.fileId !== undefined)
      throw uploadOrderInvalid("上传会话不存在");
    if (parsed.chunkIndex !== 0)
      throw uploadOrderInvalid("首个分块必须从 0 开始");
    if (parsed.relativePath === undefined || parsed.declaredBytes === undefined)
      throw validation("首个分块必须提供 relativePath 和 declaredBytes");
    const hex = createHash("sha256").update(`upload:${context.scope}:${context.key}`).digest("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return { id, relativePath: parsed.relativePath, fileName: basename(parsed.relativePath), declaredBytes: parsed.declaredBytes, chunkCount: parsed.chunkCount, stagingRelativePath: this.relativeToDataRoot(join(this.uploadsRoot, id, "file")), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
  }
  private async moveIntoPlace(temporaryPath: string, destination: string, hash: string, bytes: number): Promise<void> {
    const existing = await stat(destination).catch(() => null);
    if (existing !== null) {
      if (existing.size !== bytes || await hashFile(destination) !== hash)
        throw uploadOrderInvalid("同一分块已存在不同内容");
      await rm(temporaryPath, { force: true });
      return;
    }
    await rename(temporaryPath, destination);
  }
  private async assemble(session: Pick<UploadSessionRecord, "id" | "relativePath" | "declaredBytes" | "chunkCount">, chunks: ReturnType<ImportRepository["uploadChunks"]>): Promise<UploadChunkResult> {
    if (chunks.length !== session.chunkCount)
      throw uploadOrderInvalid("分块数量不完整");
    const assembled = join(this.uploadsRoot, session.id, "file");
    const partial = `${assembled}.part`;
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(partial, "w", 0o600);
    try {
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.chunk_index !== index)
          throw uploadOrderInvalid("分块顺序不完整");
        const chunkHash = createHash("sha256");
        let chunkBytes = 0;
        for await (const data of createReadStream(this.blobsPath(chunk.relative_path), { highWaterMark: MAX_BUFFER })) {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          bytes += buffer.length;
          chunkBytes += buffer.length;
          if (bytes > Math.min(session.declaredBytes, MAX_FILE_BYTES))
            throw capacity();
          hash.update(buffer);
          chunkHash.update(buffer);
          await handle.writeFile(buffer);
        }
        if (chunkBytes !== chunk.bytes || chunkHash.digest("hex") !== chunk.sha256)
          throw uploadOrderInvalid("分块文件校验失败");
      }
      await handle.sync();
    }
    finally {
      await handle.close();
    }
    if (bytes !== session.declaredBytes)
      throw validation("接收字节数与声明不一致");
    const sha256 = hash.digest("hex");
    await this.moveIntoPlace(partial, assembled, sha256, bytes);
    const reader = await open(assembled, "r");
    let sample: Buffer;
    try {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, 0);
      sample = buffer.subarray(0, bytesRead);
    }
    finally {
      await reader.close();
    }
    let textSample: string | null = null;
    if (/\.(md|markdown|html?|htm)$/iu.test(session.relativePath)) {
      try {
        textSample = decodeUtf8Sample(sample, sample.length >= bytes);
      }
      catch {
        throw new ApiError({ statusCode: 422, code: "SOURCE_UNREADABLE", message: "Markdown 不是有效 UTF-8" });
      }
    }
    const magic = sniffMagic(sample, session.relativePath, textSample);
    return UploadChunkResultSchema.parse({ fileId: session.id, receivedBytes: bytes, nextChunk: session.chunkCount, complete: true, sha256, bytes, mime: magic.mime ?? "application/octet-stream", magicKind: magic.kind });
  }
  private relativeToDataRoot(path: string): string { return path.slice(this.dataRoot.length + 1); }
  private blobsPath(path: string): string { const absolute = resolve(this.dataRoot, path); if (!absolute.startsWith(`${this.dataRoot}/`))
    throw validation("暂存路径越界"); return absolute; }
}
function capacity(): ApiError { return new ApiError({ statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: "上传超出声明容量或 2GiB" }); }
async function streamToFile(stream: NodeJS.ReadableStream, path: string, maxBytes: number): Promise<{
  sha256: string;
  bytes: number;
}> {
  const handle = await open(path, "w", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const data of stream) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        throw new ApiError({
          statusCode: 413,
          code: "PAYLOAD_TOO_LARGE",
          message: "分块超过声明的剩余容量或 8MiB",
        });
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
  }
  finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) {
    hash.update(data as Buffer);
  }
  return hash.digest("hex");
}
function parseUploadResponse(response: unknown): UploadChunkResult {
  return z
    .strictObject({ data: UploadChunkResultSchema, requestId: z.string() })
    .parse(response).data;
}
function validation(message: string): ApiError {
  return new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message });
}
function uploadOrderInvalid(message: string): ApiError {
  return new ApiError({ statusCode: 409, code: "UPLOAD_ORDER_INVALID", message });
}
function idempotencyConflict(): ApiError {
  return new ApiError({
    statusCode: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "同一 Idempotency-Key 对应了不同请求",
  });
}
