import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { UtcTimeSchema } from "@dmall/contracts";
import { ApiError } from "./errors.js";

const SessionRowSchema = z.strictObject({
  id_hash: z.string(),
  csrf_token: z.string(),
  created_at: UtcTimeSchema,
  last_seen_at: UtcTimeSchema,
});

const COOKIE_NAME = "dcw_session";

export class SessionService {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  ensure(request: FastifyRequest, reply: FastifyReply): { sessionIdHash: string; csrfToken: string } {
    const raw = readCookie(request.headers.cookie, COOKIE_NAME);
    if (raw !== null) {
      const session = this.find(raw);
      if (session !== null) {
        this.touch(session.id_hash);
        return { sessionIdHash: session.id_hash, csrfToken: session.csrf_token };
      }
    }

    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const idHash = hashSessionId(sessionId);
    const now = nowUtc();
    this.db
      .prepare(
        "INSERT INTO local_sessions(id_hash, csrf_token, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(idHash, csrfToken, now, now);
    reply.header("set-cookie", serializeSessionCookie(sessionId));
    return { sessionIdHash: idHash, csrfToken };
  }

  require(request: FastifyRequest): { sessionIdHash: string; csrfToken: string } {
    const raw = readCookie(request.headers.cookie, COOKIE_NAME);
    if (raw === null) {
      throw new ApiError({
        statusCode: 401,
        code: "CSRF_INVALID",
        message: "缺少本地会话，请先打开工作台",
      });
    }
    const session = this.find(raw);
    if (session === null) {
      throw new ApiError({
        statusCode: 401,
        code: "CSRF_INVALID",
        message: "本地会话已过期，请刷新页面",
      });
    }
    return { sessionIdHash: session.id_hash, csrfToken: session.csrf_token };
  }

  verifyCsrf(request: FastifyRequest, expected: string): void {
    const provided = request.headers["x-csrf-token"];
    if (typeof provided !== "string" || !safeEqual(provided, expected)) {
      throw new ApiError({
        statusCode: 403,
        code: "CSRF_INVALID",
        message: "写请求缺少有效的 CSRF 令牌",
      });
    }
  }

  private find(rawSessionId: string): z.infer<typeof SessionRowSchema> | null {
    const row = this.db
      .prepare(
        "SELECT id_hash, csrf_token, created_at, last_seen_at FROM local_sessions WHERE id_hash = ?",
      )
      .get(hashSessionId(rawSessionId));
    if (row === undefined) return null;
    return SessionRowSchema.parse(row);
  }

  private touch(idHash: string): void {
    this.db
      .prepare("UPDATE local_sessions SET last_seen_at = ? WHERE id_hash = ?")
      .run(nowUtc(), idHash);
  }
}

export interface SessionView {
  sessionIdHash: string;
  csrfToken: string;
}

function hashSessionId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length > 0) return rest.join("=");
  }
  return null;
}

function serializeSessionCookie(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}

function nowUtc(): string {
  return new Date().toISOString();
}
