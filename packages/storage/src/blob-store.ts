import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix, resolve, sep } from "node:path";
import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface BlobWriteInput {
  source: AsyncIterable<Uint8Array>;
  expectedSha256?: string;
  mime?: string;
}

export interface BlobWriteResult {
  sha256: string;
  bytes: number;
  relativePath: string;
  deduped: boolean;
  mime: string | null;
}

export interface BlobDescriptor {
  sha256: string;
  bytes: number;
  relativePath: string;
}

export class BlobHashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`文件 hash 不匹配，期望 ${expected}，实际 ${actual}`);
    this.name = "BlobHashMismatchError";
  }
}

export class BlobStore {
  readonly dataRoot: string;
  readonly blobsRoot: string;
  readonly stagingRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = resolve(dataRoot);
    this.blobsRoot = join(this.dataRoot, "blobs", "sha256");
    this.stagingRoot = join(this.dataRoot, "staging");
  }

  async initialize(): Promise<void> {
    await mkdir(this.blobsRoot, { recursive: true });
    await mkdir(this.stagingRoot, { recursive: true });
  }

  async putStream(input: BlobWriteInput): Promise<BlobWriteResult> {
    await this.initialize();
    if (input.expectedSha256 !== undefined) HashSchema.parse(input.expectedSha256);
    const temporaryPath = join(this.stagingRoot, `blob-${randomUUID()}.part`);
    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;

    try {
      for await (const chunk of input.source) {
        const buffer = Buffer.from(chunk);
        hash.update(buffer);
        bytes += buffer.byteLength;
        await handle.write(buffer);
      }
      await handle.sync();
      const sha256 = hash.digest("hex");
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256) {
        throw new BlobHashMismatchError(input.expectedSha256, sha256);
      }
      const relativePath = this.relativePathForHash(sha256);
      const destination = join(this.dataRoot, relativePath);
      await mkdir(dirname(destination), { recursive: true });

      let deduped = false;
      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        deduped = true;
      }
      return {
        sha256,
        bytes,
        relativePath: posix.normalize(relativePath.split(sep).join(posix.sep)),
        deduped,
        mime: input.mime ?? null,
      };
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async putFile(input: { path: string; mime?: string; expectedSha256?: string }): Promise<BlobWriteResult> {
    const source = createReadStream(input.path);
    return this.putStream({
      source,
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      ...(input.mime === undefined ? {} : { mime: input.mime }),
    });
  }

  async putBytes(input: { bytes: Uint8Array; mime?: string; expectedSha256?: string }): Promise<BlobWriteResult> {
    return this.putStream({
      source: (async function* () {
        yield input.bytes;
      })(),
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      ...(input.mime === undefined ? {} : { mime: input.mime }),
    });
  }

  async describe(sha256: string): Promise<BlobDescriptor | null> {
    HashSchema.parse(sha256);
    const relativePath = this.relativePathForHash(sha256);
    try {
      const file = await stat(join(this.dataRoot, relativePath));
      return { sha256, bytes: file.size, relativePath };
    } catch {
      return null;
    }
  }

  async verify(sha256: string): Promise<boolean> {
    HashSchema.parse(sha256);
    const path = this.pathForHash(sha256);
    const hash = createHash("sha256");
    try {
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch {
      return false;
    }
    return hash.digest("hex") === sha256;
  }

  createReadStream(sha256: string): NodeJS.ReadableStream {
    HashSchema.parse(sha256);
    return createReadStream(this.pathForHash(sha256));
  }

  pathForHash(sha256: string): string {
    HashSchema.parse(sha256);
    return join(this.dataRoot, this.relativePathForHash(sha256));
  }

  relativePathForHash(sha256: string): string {
    HashSchema.parse(sha256);
    return join("blobs", "sha256", sha256.slice(0, 2), sha256);
  }

  resolveRelativePath(relativePath: string): string {
    if (isAbsolute(relativePath)) throw new Error("blob 相对路径不能是绝对路径");
    const normalized = normalize(relativePath);
    if (normalized.startsWith("..") || normalized.includes(`..${sep}`)) {
      throw new Error("blob 相对路径不能越界");
    }
    return join(this.dataRoot, normalized);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
