import { z } from "zod";
import { ApiError } from "../errors.js";

export async function verifyFeishuDocument(documentId: string): Promise<{ url: string }> {
  const token = process.env.DCW_FEISHU_USER_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new ApiError({ statusCode: 409, code: "FEISHU_AUTH_MISSING", message: "核对原文档需要飞书用户授权" });
  }
  const response = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = z.object({ code: z.number(), data: z.object({
    document: z.object({ document_id: z.string() }),
  }).optional() }).safeParse(await response.json());
  if (!response.ok || !body.success || body.data.code !== 0
    || body.data.data?.document.document_id !== documentId) {
    throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "无法访问并核对指定的原飞书文档" });
  }
  return { url: `https://feishu.cn/docx/${encodeURIComponent(documentId)}` };
}
