const CONTROL_AND_ZERO_WIDTH = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

export function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function normalizeTagName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(CONTROL_AND_ZERO_WIDTH, "")
    .trim()
    .replace(/\s+/gu, " ");
}

export function normalizeTags(values: readonly string[]): { display: string[]; keys: string[] } {
  const display: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTagName(value);
    if (normalized === "") continue;
    if ([...normalized].length > 32) {
      throw new Error(`标签超过 32 个字符：${normalized}`);
    }
    const key = normalized.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    display.push(normalized);
    keys.push(key);
  }
  if (display.length > 20) throw new Error("标签最多 20 个");
  return { display, keys };
}

export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/u, "");
  const title = [...normalizeTitle(withoutExtension)].slice(0, 200).join("");
  return title === "" ? "未命名素材" : title;
}
