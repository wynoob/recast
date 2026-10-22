import { open } from "node:fs/promises";
import { basename } from "node:path";

export class FeishuApiError extends Error {
  readonly code: number;
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, code: number, status: number, retryable: boolean) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface FeishuBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  [key: string]: unknown;
}

export interface FeishuDocument {
  documentId: string;
  revisionId: string;
  title: string;
  url: string;
}

export class FeishuClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(input?: { token?: string; baseUrl?: string }) {
    const token = input?.token ?? process.env.DCW_FEISHU_USER_ACCESS_TOKEN?.trim();
    if (token === undefined || token === "") {
      throw new FeishuApiError("飞书用户凭证未配置", 0, 0, false);
    }
    this.token = token;
    this.baseUrl = input?.baseUrl ?? "https://open.feishu.cn/open-apis";
  }

  async createDocument(input: { title: string; folderToken: string | null }): Promise<FeishuDocument> {
    const data = await this.request("POST", "/docx/v1/documents", {
      ...(input.folderToken === null ? {} : { folder_token: input.folderToken }),
      title: input.title,
    }, {});
    const document = requireRecord(data, "document");
    const documentId = String(document.document_id ?? "");
    if (documentId === "") throw new FeishuApiError("飞书创建文档响应缺少 document_id", 0, 200, false);
    return {
      documentId,
      revisionId: String(document.revision_id ?? ""),
      title: String(document.title ?? input.title),
      url: `https://feishu.cn/docx/${documentId}`,
    };
  }

  async getDocument(documentId: string): Promise<{ title: string; revisionId: string; url: string }> {
    const data = await this.request(
      "GET",
      `/docx/v1/documents/${encodeURIComponent(documentId)}`,
      undefined,
      {},
    );
    const document = requireRecord(data, "document");
    return {
      title: String(document.title ?? `飞书取回 ${documentId}`),
      revisionId: String(document.revision_id ?? ""),
      url: `https://feishu.cn/docx/${documentId}`,
    };
  }

  async createChildren(input: {
    documentId: string;
    parentBlockId: string;
    children: unknown[];
    index?: number;
    clientToken: string;
    documentRevisionId?: number;
  }): Promise<{ children: FeishuBlock[]; revisionId: number | null }> {
    const data = await this.request(
      "POST",
      `/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.parentBlockId)}/children`,
      {
        children: input.children,
        ...(input.index === undefined ? {} : { index: input.index }),
      },
      {
        client_token: input.clientToken,
        ...(input.documentRevisionId === undefined
          ? {}
          : { document_revision_id: String(input.documentRevisionId) }),
      },
    );
    const children = Array.isArray(data.children) ? data.children.map(asBlock) : [];
    return {
      children,
      revisionId: typeof data.document_revision_id === "number" ? data.document_revision_id : null,
    };
  }

  async patchBlock(input: {
    documentId: string;
    blockId: string;
    body: Record<string, unknown>;
    clientToken: string;
    documentRevisionId?: number;
  }): Promise<number | null> {
    const data = await this.request(
      "PATCH",
      `/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.blockId)}`,
      input.body,
      {
        client_token: input.clientToken,
        ...(input.documentRevisionId === undefined
          ? {}
          : { document_revision_id: String(input.documentRevisionId) }),
      },
    );
    return typeof data.document_revision_id === "number" ? data.document_revision_id : null;
  }

  async uploadImage(input: {
    documentId: string;
    blockId: string;
    filePath: string;
    fileName: string;
  }): Promise<string> {
    const handle = await open(input.filePath, "r");
    const fileStat = await handle.stat();
    if (fileStat.size > 20 * 1024 * 1024) {
      await handle.close();
      throw new FeishuApiError("图片超过 20MiB，首版阻止上传", 0, 413, false);
    }
    const form = new FormData();
    form.append("file_name", input.fileName);
    form.append("parent_type", "docx_image");
    form.append("parent_node", input.blockId);
    form.append("size", String(fileStat.size));
    form.append("file", new Blob([await handle.readFile()]), basename(input.fileName));
    await handle.close();
    const response = await fetch(`${this.baseUrl}/drive/v1/medias/upload_all`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
    });
    const data = await parseResponse(response);
    const fileToken = String(data.file_token ?? "");
    if (fileToken === "") throw new FeishuApiError("飞书图片上传响应缺少 file_token", 0, response.status, false);
    return fileToken;
  }

  async listBlocks(input: { documentId: string; pageToken?: string }): Promise<{
    items: FeishuBlock[];
    hasMore: boolean;
    pageToken: string | null;
  }> {
    const data = await this.request(
      "GET",
      `/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks`,
      undefined,
      {
        page_size: "500",
        document_revision_id: "-1",
        ...(input.pageToken === undefined ? {} : { page_token: input.pageToken }),
      },
    );
    return {
      items: Array.isArray(data.items) ? data.items.map(asBlock) : [],
      hasMore: data.has_more === true,
      pageToken: typeof data.page_token === "string" && data.page_token !== "" ? data.page_token : null,
    };
  }

  async listChildren(input: {
    documentId: string;
    parentBlockId: string;
    pageToken?: string;
  }): Promise<{ items: FeishuBlock[]; hasMore: boolean; pageToken: string | null }> {
    const data = await this.request(
      "GET",
      `/docx/v1/documents/${encodeURIComponent(input.documentId)}/blocks/${encodeURIComponent(input.parentBlockId)}/children`,
      undefined,
      {
        page_size: "500",
        document_revision_id: "-1",
        ...(input.pageToken === undefined ? {} : { page_token: input.pageToken }),
      },
    );
    return {
      items: Array.isArray(data.items) ? data.items.map(asBlock) : [],
      hasMore: data.has_more === true,
      pageToken: typeof data.page_token === "string" && data.page_token !== "" ? data.page_token : null,
    };
  }

  async downloadMedia(fileToken: string): Promise<{
    bytes: Uint8Array;
    mime: string;
    fileName: string;
  }> {
    const response = await fetch(
      `${this.baseUrl}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      { method: "GET", headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      throw new FeishuApiError(`下载飞书媒体失败：HTTP ${response.status}`, 0, response.status, response.status >= 500);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime: response.headers.get("content-type") ?? "application/octet-stream",
      fileName: fileToken,
    };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    query: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return parseResponse(response);
  }
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.json().catch(() => null) as unknown;
  if (raw === null || typeof raw !== "object") {
    throw new FeishuApiError(`飞书响应不是 JSON：HTTP ${response.status}`, 0, response.status, response.status >= 500);
  }
  const payload = raw as Record<string, unknown>;
  const code = typeof payload.code === "number" ? payload.code : 0;
  if (!response.ok || code !== 0) {
    throw new FeishuApiError(
      String(payload.msg ?? `飞书请求失败：HTTP ${response.status}`),
      code,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  const data = payload.data;
  return data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
}

function requireRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (child === null || typeof child !== "object") {
    throw new FeishuApiError(`飞书响应缺少 ${key}`, 0, 200, false);
  }
  return child as Record<string, unknown>;
}

function asBlock(value: unknown): FeishuBlock {
  if (value === null || typeof value !== "object") {
    throw new FeishuApiError("飞书块结构无效", 0, 200, false);
  }
  const block = value as Record<string, unknown>;
  if (typeof block.block_id !== "string" || typeof block.block_type !== "number") {
    throw new FeishuApiError("飞书块缺少 block_id 或 block_type", 0, 200, false);
  }
  return block as FeishuBlock;
}
