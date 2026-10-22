import { createReadStream, writeSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { unzipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";

export interface ZipEntryInput {
  path: string;
  bytes?: Uint8Array;
  sourcePath?: string;
  compress?: boolean;
}

export async function writeZipFile(outputPath: string, entries: ZipEntryInput[]): Promise<number> {
  const handle = await open(outputPath, "w", 0o600);
  let bytes = 0;
  let zipError: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error !== null) {
      zipError = error;
      return;
    }
    if (data.length === 0) return;
    writeSync(handle.fd, data);
    bytes += data.length;
  });
  try {
    for (const input of entries) {
      validateZipPath(input.path);
      const entry: ZipPassThrough | ZipDeflate = input.compress === false
        ? new ZipPassThrough(input.path)
        : new ZipDeflate(input.path, { level: 6 });
      zip.add(entry);
      if (input.bytes !== undefined) {
        entry.push(input.bytes, true);
      } else if (input.sourcePath !== undefined) {
        const fileStat = await stat(input.sourcePath);
        if (!fileStat.isFile()) throw new Error(`ZIP 来源不是普通文件: ${input.sourcePath}`);
        for await (const chunk of createReadStream(input.sourcePath, { highWaterMark: 512 * 1024 })) {
          entry.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false);
          if (zipError !== null) throw zipError;
        }
        entry.push(new Uint8Array(0), true);
      } else {
        entry.push(new Uint8Array(0), true);
      }
      if (zipError !== null) throw zipError;
    }
    zip.end();
    if (zipError !== null) throw zipError;
    await handle.sync();
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function validateZipPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("..") ||
    path.includes("\\") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path)
  ) {
    throw new Error(`ZIP 路径不安全: ${path}`);
  }
}

export function unzipFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes, {
    filter: (file) =>
      file.name.length <= 512 &&
      !file.name.includes("..") &&
      !file.name.startsWith("/") &&
      !file.name.includes("\\"),
  });
}
