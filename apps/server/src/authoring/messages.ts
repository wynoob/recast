import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  MessageViewSchema,
  type CreateMessageRequest,
  type MessageView,
} from "@dmall/contracts";
import { ApiError } from "../errors.js";

const ConversationRowSchema = z.strictObject({
  id: z.uuid(),
  content_id: z.uuid(),
});

const MessageRowSchema = z.strictObject({
  id: z.uuid(),
  conversation_id: z.uuid(),
  rendition_id: z.uuid().nullable(),
  role: z.enum(["system", "user", "assistant"]),
  text: z.string(),
  mode: z.enum(["plan", "revise", "note", "confirm_outline", "historical"]),
  target_node_ids_json: z.string(),
  candidate_id: z.uuid().nullable(),
  job_id: z.uuid().nullable(),
  plan_id: z.string().nullable(),
  transcript_id: z.string().nullable(),
  created_at: z.string(),
});

export class MessageService {
  constructor(private readonly db: Database.Database) {}

  list(contentId: string): MessageView[] {
    this.requireContent(contentId);
    const rows = this.db.prepare(
      `SELECT m.id, m.conversation_id, m.rendition_id, m.role, m.text, m.mode,
              m.target_node_ids_json, m.candidate_id, m.job_id, m.plan_id,
              m.transcript_id, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.content_id = ?
       ORDER BY m.created_at, m.id`,
    ).all(contentId);
    return z.array(MessageRowSchema).parse(rows).map(toMessageView);
  }

  create(contentId: string, request: CreateMessageRequest): MessageView {
    this.requireContent(contentId);
    if (request.renditionId !== null) this.requireRendition(contentId, request.renditionId);
    const conversationId = this.conversationId(contentId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO messages(
        id, conversation_id, rendition_id, role, text, target_node_ids_json,
        candidate_id, created_at, mode
      ) VALUES (?, ?, ?, 'user', ?, ?, NULL, ?, ?)`,
    ).run(
      id,
      conversationId,
      request.renditionId,
      request.text,
      JSON.stringify(request.targetNodeIds),
      now,
      request.mode,
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
    return this.requireMessage(id);
  }

  createAssistant(input: {
    contentId: string;
    renditionId: string | null;
    text: string;
    mode: "plan" | "revise" | "note";
    jobId?: string | null;
    candidateId?: string | null;
    planId?: string | null;
    targetNodeIds?: readonly string[];
  }): MessageView {
    this.requireContent(input.contentId);
    const conversationId = this.conversationId(input.contentId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO messages(
        id, conversation_id, rendition_id, role, text, target_node_ids_json,
        candidate_id, job_id, plan_id, created_at, mode
      ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      conversationId,
      input.renditionId,
      input.text,
      JSON.stringify(input.targetNodeIds ?? []),
      input.candidateId ?? null,
      input.jobId ?? null,
      input.planId ?? null,
      now,
      input.mode,
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
    return this.requireMessage(id);
  }

  requireMessage(id: string): MessageView {
    const row = this.db.prepare(
      `SELECT id, conversation_id, rendition_id, role, text, mode,
              target_node_ids_json, candidate_id, job_id, plan_id, transcript_id, created_at
       FROM messages WHERE id = ?`,
    ).get(id);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "消息不存在" });
    }
    return toMessageView(MessageRowSchema.parse(row));
  }

  requireUserMessage(contentId: string, id: string): MessageView {
    const row = this.db.prepare(
      `SELECT m.id, m.conversation_id, m.rendition_id, m.role, m.text, m.mode,
              m.target_node_ids_json, m.candidate_id, m.job_id, m.plan_id,
              m.transcript_id, m.created_at, c.content_id
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ?`,
    ).get(id);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "消息不存在" });
    }
    const parsed = MessageRowSchema.extend({ content_id: z.uuid() }).parse(row);
    if (parsed.content_id !== contentId || parsed.role !== "user") {
      throw new ApiError({
        statusCode: 422,
        code: "UNKNOWN_REFERENCE",
        message: "确认消息必须属于同一内容的真实用户消息",
      });
    }
    return toMessageView(parsed);
  }

  conversationId(contentId: string): string {
    const row = this.db.prepare(
      "SELECT id, content_id FROM conversations WHERE content_id = ? ORDER BY created_at, id LIMIT 1",
    ).get(contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 409, code: "VALIDATION_ERROR", message: "内容没有创作会话" });
    }
    return ConversationRowSchema.parse(row).id;
  }

  private requireContent(contentId: string): void {
    const row = this.db.prepare("SELECT id FROM contents WHERE id = ?").get(contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "内容不存在" });
    }
  }

  private requireRendition(contentId: string, renditionId: string): void {
    const row = this.db.prepare(
      "SELECT id FROM renditions WHERE id = ? AND content_id = ?",
    ).get(renditionId, contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "稿件分支不存在" });
    }
  }
}

function toMessageView(row: z.infer<typeof MessageRowSchema>): MessageView {
  return MessageViewSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    renditionId: row.rendition_id,
    role: row.role,
    text: row.text,
    mode: row.mode,
    targetNodeIds: JSON.parse(row.target_node_ids_json) as unknown,
    candidateId: row.candidate_id,
    jobId: row.job_id,
    planId: row.plan_id,
    transcriptId: row.transcript_id,
    createdAt: row.created_at,
  });
}
