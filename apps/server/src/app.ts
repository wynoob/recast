import { Composer } from "./authoring/composer.js";
import { registerComposerRoutes } from "./authoring/composer-routes.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { z, ZodError } from "zod";
import {
  ApiSuccessSchema,
  ContentListSchema,
  CreateFixtureJobRequestSchema,
  CreateLocalProbeRequestSchema,
  JobInputSchema,
  JobSnapshotSchema,
  SettingsSchema,
  type CapabilityState,
  type JobEvent,
} from "@dmall/contracts";
import { openDatabase, BlobStore, type OpenDatabaseResult } from "@dmall/storage";
import { loadConfig, type RuntimeConfig } from "./config.js";
import { ApiError, requestIdFor, sendApiError } from "./errors.js";
import { SessionService, type SessionView } from "./session.js";
import { IdempotencyRepository, type IdempotencyRecord } from "./idempotency.js";
import { ContentRepository, parseCreateContent, parseUpdateContent } from "./content-repository.js";
import { LibraryRepository } from "./library-repository.js";
import { JobRepository } from "./job-repository.js";
import { JobEventBus } from "./event-bus.js";
import { WorkerPool } from "./worker-pool.js";
import { JobScheduler } from "./scheduler.js";
import { InstanceLock } from "./instance-lock.js";
import { ImportService } from "./import-service.js";
import { UploadService } from "./upload-service.js";
import { registerImportRoutes } from "./import-routes.js";
import { registerFileRoutes } from "./file-routes.js";
import { RevisionRepository } from "./authoring/revisions.js";
import { registerAuthoringRoutes } from "./authoring/routes.js";
import { DocumentRepository } from "./documents/repository.js";
import { KeywordIndexService } from "./retrieval/index-service.js";
import { FactService } from "./facts/fact-service.js";
import { RetrievalService } from "./retrieval/retrieval-service.js";
import { registerRetrievalRoutes } from "./retrieval/routes.js";
import { TemplateRepository } from "./templates/template-repository.js";
import { registerTemplateRoutes } from "./templates/routes.js";
import { RemoteOperationRepository } from "./remote-operations.js";
import { OutputRepository } from "./outputs/output-repository.js";
import { registerOutputRoutes } from "./outputs/routes.js";
import { AuthoringEvidenceService } from "./authoring-evidence.js";
import { registerFullAuthoringRoutes } from "./authoring/authoring-routes.js";
import { CandidateAcceptService } from "./authoring/accept.js";
import { CandidateService } from "./authoring/candidates.js";
import { DeriveService } from "./authoring/derive.js";
import { GenerationInputService } from "./authoring/generation-inputs.js";
import { LocalGenerationService } from "./authoring/local-generation.js";
import { MessageService } from "./authoring/messages.js";
import { PlanService } from "./authoring/plans.js";
import { ProviderJournal } from "./authoring/provider-journal.js";
import { registerProviderRoutes } from "./authoring/provider-routes.js";

export interface AppContext {
  app: FastifyInstance;
  config: RuntimeConfig;
  database: OpenDatabaseResult;
  jobs: JobRepository;
  scheduler: JobScheduler;
  events: JobEventBus;
  pool: WorkerPool;
  imports: ImportService;
  uploads: UploadService;
  library: LibraryRepository;
  documents: DocumentRepository;
  index: KeywordIndexService;
  facts: FactService;
  retrieval: RetrievalService;
  templates: TemplateRepository;
  outputs: OutputRepository;
  authoringEvidence: AuthoringEvidenceService;
  messages: MessageService;
  plans: PlanService;
  generationInputs: GenerationInputService;
  candidates: CandidateService;
  accept: CandidateAcceptService;
  localGeneration: LocalGenerationService;
  derive: DeriveService;
  providerJournal: ProviderJournal;
  composer: Composer;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOCAL_IMPORT_FEATURE_STATE = "implemented_pending_acceptance" as const;

export async function createApp(input?: {
  config?: RuntimeConfig;
  startWorkers?: boolean;
}): Promise<AppContext> {
  const config = input?.config ?? loadConfig();
  const lock = new InstanceLock(join(config.dataRoot, "instance.lock"));
  await lock.acquire();
  let openedDatabase: OpenDatabaseResult | null = null;
  let openedScheduler: JobScheduler | null = null;
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await openedScheduler?.close();
    } finally {
      try {
        openedDatabase?.db.close();
      } finally {
        await lock.release();
      }
    }
  };
  try {
    const database = await openDatabase({ dbPath: config.dbPath, backupDir: config.backupDir });
    openedDatabase = database;
    const blobs = new BlobStore(config.dataRoot);
    await blobs.initialize();
    const sessions = new SessionService(database.db);
    const idempotency = new IdempotencyRepository(database.db);
    const contents = new ContentRepository(database.db, idempotency);
    const revisions = new RevisionRepository(database.db, idempotency);
    const documents = new DocumentRepository(database.db);
    const index = new KeywordIndexService(database.db, blobs);
    const library = new LibraryRepository(
      database.db,
      blobs,
      idempotency,
      documents,
      index,
    );
    const jobs = new JobRepository(database.db);
    const facts = new FactService({
      db: database.db,
      documents,
      index,
      idempotency,
    });
    const retrieval = new RetrievalService({
      db: database.db,
      index,
      documents,
      facts,
      idempotency,
    });
    const authoringEvidence = new AuthoringEvidenceService({
      db: database.db,
      retrieval,
    });
    const messages = new MessageService(database.db);
    const plans = new PlanService(database.db, messages);
    const generationInputs = new GenerationInputService(database.db, authoringEvidence, plans);
    const candidates = new CandidateService(database.db, revisions, generationInputs);
    const accept = new CandidateAcceptService(
      database.db,
      revisions,
      candidates,
      idempotency,
      generationInputs,
      plans,
    );
    const localGeneration = new LocalGenerationService(
      database.db,
      revisions,
      generationInputs,
      candidates,
      plans,
      messages,
    );
    const derive = new DeriveService(database.db, contents, plans);
    const templates = new TemplateRepository({
      db: database.db,
      blobs,
      idempotency,
      jobs,
      dataRoot: config.dataRoot,
    });
    const remoteOps = new RemoteOperationRepository(database.db);
    const imports = new ImportService({
      db: database.db,
      blobs,
      dataRoot: config.dataRoot,
      jobs,
      idempotency,
      index,
    });
    const uploads = new UploadService({
      db: database.db,
      dataRoot: config.dataRoot,
      imports: imports.repository,
      idempotency,
    });
    const outputs = new OutputRepository({
      db: database.db,
      blobs,
      idempotency,
      jobs,
      dataRoot: config.dataRoot,
      imports: imports.repository,
    });
    const events = new JobEventBus();
    const pool = new WorkerPool({
      size: config.workerPoolSize,
      ...(process.env.DCW_WORKER_ENTRY === undefined
        ? {}
        : { entry: process.env.DCW_WORKER_ENTRY }),
    });
    const app = Fastify({
      routerOptions: { maxParamLength: 1024 },
      logger: {
        level: process.env.DCW_LOG_LEVEL ?? "info",
        redact: ["req.headers.cookie", "req.headers.x-csrf-token"],
      },
      trustProxy: false,
      bodyLimit: 25 * 1024 * 1024,
    });
    await app.register(multipart, {
      limits: {
        fileSize: 8 * 1024 * 1024,
        files: 1,
        fields: 16,
        parts: 32,
      },
      throwFileSizeLimit: true,
    });
    const providerJournal = new ProviderJournal(database.db);
    jobs.setRecoveryClassifier((id) => providerJournal.classifyRecovery(id));
    const composer = new Composer({ db: database.db, blobs, contents, jobs, plans, evidence: authoringEvidence, retrieval, messages,
      inputs: generationInputs, candidates, accept, revisions, journal: providerJournal, outputs });
    const scheduler = new JobScheduler({
      jobs,
      pool,
      events,
      logger: app.log,
      imports,
      providerJournal,
      remoteOps,
      prepareOutputGrant: (grant) => outputs.prepareGrant(grant),
      prepareCompletion: (jobId, result) => outputs.prepareCompletion(jobId, result),
      advanceCompositions: () => composer.sweep(),
    });
    openedScheduler = scheduler;
    const requestSessions = new WeakMap<FastifyRequest, SessionView>();

    registerBoundaryHooks(app, config, sessions, idempotency, requestSessions);
    registerRoutes({
      app,
      config,
      db: database,
      blobs,
      sessions,
      idempotency,
      contents,
      revisions,
      library,
      documents,
      facts,
      retrieval,
      authoringEvidence,
      messages,
      plans,
      generationInputs,
      candidates,
      accept,
      localGeneration,
      derive,
      providerJournal,
      templates,
      outputs,
      imports,
      uploads,
      jobs,
      scheduler,
      pool,
      events,
      requestSessions,
    });

    registerComposerRoutes({ app, composer, idempotency, kick: () => scheduler.kick() });

    if (input?.startWorkers !== false) {
      await scheduler.start();
    }
    registerFileRoutes({ app, blobs, db: database.db });
    await registerStatic(app, config);

    app.addHook("onClose", cleanup);

    return {
      composer,
      app,
      config,
      database,
      jobs,
      scheduler,
      events,
      pool,
      imports,
      uploads,
      library,
      documents,
      index,
      facts,
      retrieval,
      templates,
      outputs,
      authoringEvidence,
      messages,
      plans,
      generationInputs,
      candidates,
      accept,
      localGeneration,
      derive,
      providerJournal,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }

}

function registerBoundaryHooks(
  app: FastifyInstance,
  config: RuntimeConfig,
  sessions: SessionService,
  idempotency: IdempotencyRepository,
  requestSessions: WeakMap<FastifyRequest, SessionView>,
): void {
  app.addHook("onRequest", async (request, reply) => {
    checkHostAndOrigin(request, config);
    if (request.method === "GET" || request.method === "HEAD") {
      requestSessions.set(request, sessions.ensure(request, reply));
      return;
    }
    if (WRITE_METHODS.has(request.method)) {
      const session = sessions.require(request);
      sessions.verifyCsrf(request, session.csrfToken);
      idempotency.requireKey(request.headers["idempotency-key"]);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      sendApiError(reply, request, error);
      return;
    }
    if (error instanceof ZodError) {
      request.log.error({ err: error }, "request schema validation failed");
      sendApiError(reply, request, new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "请求字段不符合契约",
        details: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
      }));
      return;
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode < 500) {
      sendApiError(reply, request, new ApiError({
        statusCode,
        code: statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
        message:
          typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
            ? error.message
            : "请求不合法",
      }));
      return;
    }
    request.log.error({ err: error }, "unhandled request error");
    sendApiError(reply, request, new ApiError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "服务内部错误",
    }));
  });
}

function checkHostAndOrigin(request: FastifyRequest, config: RuntimeConfig): void {
  const host = request.headers.host;
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
    `[::1]:${config.port}`,
  ]);
  if (typeof host !== "string" || !allowedHosts.has(host.toLowerCase())) {
    throw new ApiError({
      statusCode: 403,
      code: "HOST_NOT_ALLOWED",
      message: "只接受本机回环地址",
    });
  }
  const origin = request.headers.origin;
  if (origin === undefined) return;
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...config.devOrigins,
  ]);
  if (!allowedOrigins.has(origin)) {
    throw new ApiError({
      statusCode: 403,
      code: "ORIGIN_NOT_ALLOWED",
      message: "请求来源不是本机工作台",
    });
  }
}

function registerRoutes(input: {
  app: FastifyInstance;
  config: RuntimeConfig;
  db: OpenDatabaseResult;
  blobs: BlobStore;
  sessions: SessionService;
  idempotency: IdempotencyRepository;
  contents: ContentRepository;
  revisions: RevisionRepository;
  library: LibraryRepository;
  documents: DocumentRepository;
  facts: FactService;
  retrieval: RetrievalService;
  templates: TemplateRepository;
  outputs: OutputRepository;
  authoringEvidence: AuthoringEvidenceService;
  messages: MessageService;
  plans: PlanService;
  generationInputs: GenerationInputService;
  candidates: CandidateService;
  accept: CandidateAcceptService;
  localGeneration: LocalGenerationService;
  derive: DeriveService;
  providerJournal: ProviderJournal;
  imports: ImportService;
  uploads: UploadService;
  jobs: JobRepository;
  scheduler: JobScheduler;
  pool: WorkerPool;
  events: JobEventBus;
  requestSessions: WeakMap<FastifyRequest, SessionView>;
}): void {
  const { app, config, db, sessions, idempotency, contents, revisions, library, templates, outputs, facts, retrieval, imports, uploads, jobs, scheduler, pool, events, requestSessions, authoringEvidence, messages, plans, generationInputs, candidates, accept, localGeneration, derive } = input;

  registerImportRoutes({
    app,
    imports,
    uploads,
    library,
    idempotency,
    requestIdFor,
  });

  const retiredAuthoringWrites = new Set([
    "/api/v1/renditions/:id/revisions", "/api/v1/renditions/:id/restore",
    "/api/v1/contents/:id/messages", "/api/v1/contents/:id/plan/confirm", "/api/v1/contents/:id/evidence/select",
    "/api/v1/renditions/:id/generation-inputs", "/api/v1/renditions/:id/local-generation", "/api/v1/renditions/:id/candidates",
    "/api/v1/candidates/:id/accept", "/api/v1/candidates/:id/reject", "/api/v1/contents/:id/derive",
    "/api/v1/generation-inputs/:id/generate", "/api/v1/contents/:id/transcribe",
  ]);
  app.addHook("onRoute", (route) => {
    if (route.method === "POST" && retiredAuthoringWrites.has(route.url)) {
      route.handler = async () => { throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "旧写稿入口已退出，请使用 AI 创作" }); };
    }
  });

  registerAuthoringRoutes({ app, idempotency, revisions });
  registerFullAuthoringRoutes({
    app,
    idempotency,
    revisions,
    messages,
    plans,
    evidence: authoringEvidence,
    generationInputs,
    candidates,
    accept,
    localGeneration,
    derive,
    db: db.db,
  });
  registerProviderRoutes({
    app,
    db: db.db,
    jobs,
    idempotency,
    generationInputs,
    plans,
  });
  registerRetrievalRoutes({ app, retrieval, facts, idempotency, requestIdFor });
  registerTemplateRoutes({ app, templates, idempotency });
  registerOutputRoutes({ app, outputs, idempotency, jobs });

  app.get("/api/v1/health", async (request, reply) => {
    const session = requestSessions.get(request) ?? sessions.ensure(request, reply);
    return ApiSuccessSchema(z.object({
      schemaVersion: z.literal(1),
      status: z.literal("ok"),
      appVersion: z.string(),
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
      database: z.object({
        status: z.literal("ok"),
        journalMode: z.string(),
        foreignKeys: z.boolean(),
        busyTimeoutMs: z.int().nonnegative(),
        migrationCount: z.int().nonnegative(),
      }),
      csrfToken: z.string(),
      workers: z.object({ configured: z.int().positive(), ready: z.int().nonnegative() }),
    })).parse({
      data: {
        schemaVersion: 1,
        status: "ok",
        appVersion: "0.1.0",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        database: {
          status: "ok",
          journalMode: db.info.journalMode,
          foreignKeys: db.info.foreignKeys,
          busyTimeoutMs: db.info.busyTimeoutMs,
          migrationCount: db.info.migrationCount,
        },
        csrfToken: session.csrfToken,
        workers: {
          configured: config.workerPoolSize,
          ready: pool.readyCount(),
        },
      },
      requestId: requestIdFor(request),
    });
  });

  app.get("/api/v1/settings", async (request) => {
    const providers = readProviders(db);
    return {
      data: SettingsSchema.parse({
        schemaVersion: 1,
        providers,
        feishu: { status: "unconfigured" },
        storage: { dataRoot: config.dataRoot, blobStore: "content_addressed" },
        workers: {
          poolSize: config.workerPoolSize,
          leaseSeconds: 30,
          heartbeatSeconds: 10,
        },
        features: {
          localImport: LOCAL_IMPORT_FEATURE_STATE,
          documentSearch: "implemented_pending_acceptance",
          localFacts: "implemented_pending_acceptance",
          templates: "implemented_pending_acceptance",
          editor: "available_t06",
          outputs: "available_t07",
        },
      }),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/contents", async (request) => {
    const query = parseListQuery(request.query);
    const result = contents.list({ ...query, limit: query.limit, offset: query.offset });
    return {
      data: ContentListSchema.parse({
        items: result.items,
        nextCursor:
          query.offset + result.items.length < result.total
            ? String(query.offset + query.limit)
            : null,
        total: result.total,
      }),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/contents/:id", async (request, reply) => {
    const id = parseId(request.params);
    const detail = contents.getById(id);
    return reply.send({ data: detail, requestId: requestIdFor(request) });
  });

  app.post("/api/v1/contents", async (request, reply) => {
    const body = parseCreateContent(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, "/api/v1/contents");
    const hash = idempotency.requestHash(body);
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    try {
      const detail = contents.create(body, {
        routeScope: scope,
        key,
        requestHash: hash,
        requestId: requestIdFor(request),
      });
      return reply.code(201).send({ data: detail, requestId: requestIdFor(request) });
    } catch (error) {
      const raced = idempotency.find(scope, key);
      if (raced !== null) return replay(reply, raced, hash);
      throw error;
    }
  });

  app.patch("/api/v1/contents/:id", async (request, reply) => {
    const contentId = parseId(request.params);
    if (db.db.prepare("SELECT id FROM jobs WHERE type = 'composition_provider' AND json_extract(input_json, '$.contentId') = ? LIMIT 1").get(contentId) !== undefined) {
      throw new ApiError({ statusCode: 409, code: "COMPOSITION_CONFLICT", message: "AI 创作只能通过方案调整修改要求" });
    }
    const body = parseUpdateContent(request.body);
    const id = parseId(request.params);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/contents/${id}`);
    const hash = idempotency.requestHash({ id, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const detail = contents.update({
      id,
      request: body,
      options: {
        routeScope: scope,
        key,
        requestHash: hash,
        requestId: requestIdFor(request),
      },
    });
    return reply.send({ data: detail, requestId: requestIdFor(request) });
  });

  app.post("/api/v1/jobs/local-probe", async (request, reply) => {
    const body = CreateLocalProbeRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const type = "local_env_probe";
    const jobInput = JobInputSchema.parse({ schemaVersion: 1, jobType: type });
    return createJobWithIdempotency({
      request,
      reply,
      body,
      type,
      input: jobInput,
      key,
      idempotency,
      jobs,
      db,
      scope: routeScope(request, "/api/v1/jobs/local-probe"),
    });
  });

  app.post("/api/v1/jobs/fixture", async (request, reply) => {
    const body = CreateFixtureJobRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const jobInput = JobInputSchema.parse({
      schemaVersion: 1,
      jobType: "fixture_long",
      steps: body.steps,
      stepMs: body.stepMs,
      ...(body.failAt === undefined ? {} : { failAt: body.failAt }),
    });
    return createJobWithIdempotency({
      request,
      reply,
      body,
      type: "fixture_long",
      input: jobInput,
      key,
      idempotency,
      jobs,
      db,
      scope: routeScope(request, "/api/v1/jobs/fixture"),
    });
  });

  app.get("/api/v1/jobs/:id", async (request) => {
    const id = parseId(request.params);
    return {
      data: JobSnapshotSchema.parse(jobs.snapshotById(id)),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/jobs/:id/events", async (request, reply) => {
    const id = parseId(request.params);
    const lastEventId = parseLastEventId(request);
    jobs.snapshotById(id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write("retry: 2000\n\n");
    const send = (event: JobEvent): void => {
      if (event.seq <= lastEventId) return;
      reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const replay = jobs.events(id, lastEventId);
    for (const event of replay) send(event);
    const unsubscribe = events.subscribe(id, send);
    const keepAlive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    keepAlive.unref();
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.post("/api/v1/jobs/:id/cancel", async (request, reply) => {
    const id = parseId(request.params);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/jobs/${id}/cancel`);
    const hash = idempotency.requestHash({ id });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const requestId = requestIdFor(request);
    const snapshot = scheduler.requestCancel(jobs.snapshotById(id), (current) => {
      idempotency.save({
        routeScope: scope,
        key,
        requestHash: hash,
        statusCode: 200,
        requestId,
        response: { data: current, requestId },
        resultRef: id,
      });
    });
    return reply.send({ data: snapshot, requestId });
  });

  app.post("/api/v1/jobs/:id/resume", async (request, reply) => {
    const id = parseId(request.params);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/jobs/${id}/resume`);
    const hash = idempotency.requestHash({ id });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const requestId = requestIdFor(request);
    if (db.db.prepare("SELECT e.id FROM exports e JOIN export_jobs ej ON ej.export_id = e.id WHERE ej.job_id = ? AND e.business_key IS NOT NULL").get(id) !== undefined) {
      throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "请通过原创作交付决策恢复输出" });
    }
    const snapshot = scheduler.resume(id, (current) => {
      idempotency.save({
        routeScope: scope,
        key,
        requestHash: hash,
        statusCode: 200,
        requestId,
        response: { data: current, requestId },
        resultRef: id,
      });
    });
    const response = { data: snapshot, requestId };
    return reply.send(response);
  });

  app.post("/api/v1/jobs/:id/provider-resume", async (request, reply) => {
    const id = parseId(request.params);
    const body = z.strictObject({
      schemaVersion: z.literal(1),
      decision: z.literal("explicit_retry_new_attempt"),
      expectedInputHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/jobs/${id}/provider-resume`);
    const hash = idempotency.requestHash({ id, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const requestId = requestIdFor(request);
    const snapshot = jobs.explicitProviderRetry(id, body.expectedInputHash);
    const response = { data: JobSnapshotSchema.parse(snapshot), requestId };
    idempotency.save({
      routeScope: scope,
      key,
      requestHash: hash,
      statusCode: 200,
      requestId,
      response,
      resultRef: id,
    });
    scheduler.kick();
    return reply.send(response);
  });

  app.get("/health", async (request, reply) => {
    const session = requestSessions.get(request) ?? sessions.ensure(request, reply);
    return { status: "ok", csrfToken: session.csrfToken };
  });
}

async function createJobWithIdempotency(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  body: unknown;
  type: "local_env_probe" | "fixture_long";
  input: ReturnType<typeof JobInputSchema.parse>;
  key: string;
  idempotency: IdempotencyRepository;
  jobs: JobRepository;
  db: OpenDatabaseResult;
  scope: string;
}): Promise<FastifyReply> {
  const hash = input.idempotency.requestHash(input.body);
  const existing = input.idempotency.find(input.scope, input.key);
  if (existing !== null) return replay(input.reply, existing, hash);
  const requestId = requestIdFor(input.request);
  const response = input.db.db.transaction(() => {
    const snapshot = input.jobs.create({
      type: input.type,
      input: input.input,
      inputHash: hash,
      idempotencyKey: input.key,
    });
    const body = { data: snapshot, requestId };
    input.idempotency.save({
      routeScope: input.scope,
      key: input.key,
      requestHash: hash,
      statusCode: 202,
      requestId,
      response: body,
      resultRef: snapshot.id,
    });
    return body;
  })();
  return input.reply.code(202).send(response);
}

function replay(reply: FastifyReply, existing: IdempotencyRecord, hash: string): FastifyReply {
  if (existing.requestHash !== hash) {
    throw new ApiError({
      statusCode: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "同一 Idempotency-Key 对应了不同请求",
    });
  }
  return reply.code(existing.statusCode).send(existing.response);
}

function readProviders(db: OpenDatabaseResult): {
  text: CapabilityState;
  embedding: CapabilityState;
  vision: CapabilityState;
  asr: CapabilityState;
} {
  const roles = ["text", "embedding", "vision", "asr"] as const;
  const result: Record<(typeof roles)[number], CapabilityState> = {
    text: { status: "unconfigured" },
    embedding: { status: "unconfigured" },
    vision: { status: "unconfigured" },
    asr: { status: "unconfigured" },
  };
  for (const role of roles) {
    const row = db.db
      .prepare("SELECT id, model_id, capabilities_json FROM provider_configs WHERE role = ? ORDER BY updated_at DESC LIMIT 1")
      .get(role);
    if (row === undefined) continue;
    const parsed = z.strictObject({
      id: z.uuid(),
      model_id: z.string(),
      capabilities_json: z.string(),
    }).parse(row);
    const capabilities = z.object({
      verified: z.boolean().optional(),
      probeJobId: z.string().optional(),
    }).parse(JSON.parse(parsed.capabilities_json));
    result[role] = capabilities.verified === true
      ? {
          status: "configured",
          providerId: parsed.id,
          modelId: parsed.model_id,
          probeJobId: capabilities.probeJobId ?? null,
        }
      : { status: "unverified", providerId: parsed.id, modelId: parsed.model_id };
  }
  return result;
}

function parseListQuery(query: unknown): { limit: number; offset: number; q?: string; kind?: "feishu_doc" | "html_deck" } {
  const parsed = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    q: z.string().max(200).optional(),
    kind: z.enum(["feishu_doc", "html_deck"]).optional(),
  }).parse(query);
  const offset = parsed.cursor === undefined || parsed.cursor === "" ? 0 : Number(parsed.cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "分页游标无效" });
  }
  return {
    limit: parsed.limit,
    offset,
    ...(parsed.q === undefined ? {} : { q: parsed.q }),
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
  };
}

function parseId(params: unknown): string {
  const parsed = z.strictObject({ id: z.uuid() }).parse(params);
  return parsed.id;
}

function parseLastEventId(request: FastifyRequest): number {
  const raw = request.headers["last-event-id"] ?? (request.query as { lastEventId?: string }).lastEventId;
  if (raw === undefined || raw === "") return 0;
  const parsed = z.coerce.number().int().nonnegative().safeParse(raw);
  if (!parsed.success) {
    throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "Last-Event-ID 无效" });
  }
  return parsed.data;
}

function routeScope(request: FastifyRequest, path: string): string {
  return `${request.method} ${path}`;
}

async function registerStatic(app: FastifyInstance, config: RuntimeConfig): Promise<void> {
  const index = join(config.webRoot, "index.html");
  if (!existsSync(index)) return;
  await app.register(fastifyStatic, { root: config.webRoot, wildcard: false });
  app.get("/*", async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "接口不存在" });
    }
    return reply.type("text/html; charset=utf-8").sendFile("index.html");
  });
}

