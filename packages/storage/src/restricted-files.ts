import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
export interface PathIdentity {
  path: string;
  deviceId: string;
  inode: string;
}
export class RestrictedFileError extends Error {
  readonly code = "SOURCE_CHANGED_RESCAN_REQUIRED";
  constructor() { super("源路径或目录身份发生变化，请重新扫描"); }
}
export function fileIdentity(path: string, stats: Stats): PathIdentity {
  return { path, deviceId: String(stats.dev), inode: String(stats.ino) };
}
function sameIdentity(stats: Stats, expected: PathIdentity): boolean {
  return String(stats.dev) === expected.deviceId && String(stats.ino) === expected.inode;
}
function sameFile(left: Stats, right: Stats): boolean {
  return sameIdentity(left, fileIdentity("", right)) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
export class RestrictedRoot {
  private constructor(readonly rootPath: string, readonly identity: readonly PathIdentity[]) { }
  static async capture(rootPath: string, expected?: readonly PathIdentity[]): Promise<RestrictedRoot> {
    if (!isAbsolute(rootPath))
      throw new RestrictedFileError();
    const root = resolve(rootPath);
    const paths: string[] = [sep];
    for (const segment of root.split(sep).filter(Boolean))
      paths.push(resolve(paths.at(-1) ?? sep, segment));
    const identity: PathIdentity[] = [];
    for (const path of paths) {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new RestrictedFileError();
      identity.push(fileIdentity(path, stats));
    }
    if (expected !== undefined && (expected.length !== identity.length ||
      expected.some((entry, i) => entry.path !== identity[i]?.path || entry.deviceId !== identity[i]?.deviceId || entry.inode !== identity[i]?.inode)))
      throw new RestrictedFileError();
    const boundary = new RestrictedRoot(root, identity);
    await boundary.check(identity);
    return boundary;
  }
  private absolute(path: string): string {
    const absolute = resolve(this.rootPath, path);
    const rel = relative(this.rootPath, absolute);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      throw new RestrictedFileError();
    return absolute;
  }
  private async chain(path: string, expected?: readonly PathIdentity[]): Promise<PathIdentity[]> {
    const result = [...this.identity];
    const rel = relative(this.rootPath, path);
    let parent = this.rootPath;
    for (const segment of rel.split(sep).filter(Boolean)) {
      parent = resolve(parent, segment);
      const stats = await lstat(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new RestrictedFileError();
      result.push(fileIdentity(parent, stats));
    }
    if (expected !== undefined && (expected.length !== result.length || expected.some((entry, i) => entry.path !== result[i]?.path || entry.deviceId !== result[i]?.deviceId || entry.inode !== result[i]?.inode)))
      throw new RestrictedFileError();
    await this.check(result);
    return result;
  }
  private async check(chain: readonly PathIdentity[]): Promise<void> {
    for (const entry of chain) {
      const stats = await lstat(entry.path);
      if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, entry))
        throw new RestrictedFileError();
    }
  }
  async directoryIdentity(path: string): Promise<PathIdentity[]> {
    return this.chain(this.absolute(path));
  }
  async list(path: string, expected?: readonly PathIdentity[]) {
    const absolute = this.absolute(path);
    const chain = await this.chain(absolute, expected);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const identity = chain.at(-1);
      if (identity === undefined || !sameIdentity(await handle.stat(), identity))
        throw new RestrictedFileError();
      await this.check(chain);
      // Darwin does not expose directory-FD-relative readdir in Node. Validate before accepting entries.
      const entries = await readdir(absolute, { withFileTypes: true });
      await this.check(chain);
      if (!sameIdentity(await handle.stat(), identity))
        throw new RestrictedFileError();
      return entries;
    }
    finally {
      await handle.close();
    }
  }
  async stat(path: string): Promise<Stats> {
    const absolute = this.absolute(path);
    const parent = resolve(absolute, "..");
    const chain = await this.chain(parent);
    const stats = await lstat(absolute);
    await this.check(chain);
    return stats;
  }
  async withFile<T>(input: {
    path: string;
    parents?: readonly PathIdentity[];
    expected?: {
      deviceId: string;
      inode: string;
      bytes: number;
      mtimeMs: number;
    };
    beforeOpen?: () => Promise<void>;
    read: (file: {
      handle: FileHandle;
      stats: Stats;
      parents: PathIdentity[];
      verify: () => Promise<void>;
    }) => Promise<T>;
  }): Promise<T> {
    const absolute = this.absolute(input.path);
    const parents = await this.chain(resolve(absolute, ".."), input.parents);
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink())
      throw new RestrictedFileError();
    if (input.expected !== undefined && (!sameIdentity(before, { path: absolute, ...input.expected }) ||
      before.size !== input.expected.bytes || Math.abs(before.mtimeMs - input.expected.mtimeMs) > 0.001))
      throw new RestrictedFileError();
    await input.beforeOpen?.();
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const verify = async () => {
      const current = await handle.stat();
      if (!current.isFile() || !sameFile(current, before))
        throw new RestrictedFileError();
      await this.check(parents);
      const linked = await lstat(absolute);
      if (linked.isSymbolicLink() || !sameFile(linked, current))
        throw new RestrictedFileError();
    };
    try {
      await verify();
      const result = await input.read({ handle, stats: before, parents, verify });
      await verify();
      return result;
    }
    finally {
      await handle.close();
    }
  }
}
export function decodeUtf8Sample(sample: Uint8Array, eof: boolean): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: !eof });
}
