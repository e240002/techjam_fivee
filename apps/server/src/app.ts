import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { sanitizeMetadata, sanitizeText } from "./tracing/redaction.js";
import { TraceNotFoundError } from "./tracing/trace-service.js";
import type { Trace } from "./tracing/trace-types.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const traceIdParams = z.object({ traceId: z.string().uuid() });
const runTraceParams = z.object({ runId: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

export interface TraceQueryService {
  getTrace(traceId: string): Trace;
  getTraceByRunId(runId: string): Trace | null;
}
function sanitizeTrace(
  trace: Trace,
  sensitiveValues: readonly string[],
): Trace {
  return {
    ...trace,
    spans: trace.spans.map((span) => ({
      ...span,
      error:
        span.error === null
          ? null
          : sanitizeText(span.error, sensitiveValues),
      metadata: sanitizeMetadata(span.metadata, sensitiveValues),
    })),
  };
}
export async function createApp(
  config: AppConfig,
  service: AgentService,
  traceService: TraceQueryService,
): Promise<FastifyInstance> {
  const sensitiveValues = [config.arkApiKey, config.authToken];
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    const sanitizedMessage = sanitizeText(appError.message, sensitiveValues);
    if (statusCode >= 500) {
      request.log.error(
        {
          errorName: appError.name,
          errorMessage: sanitizedMessage,
        },
        "Request failed",
      );
    }
    const exposeMessage =
      error instanceof HttpError || validationError || statusCode < 500;
    return reply.code(statusCode).send({
      error: exposeMessage ? sanitizedMessage : "Internal server error",
      ...(validationError
        ? {
            details: sanitizeMetadata(
              { details: error.issues },
              sensitiveValues,
            ).details,
          }
        : {}),
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?", 1)[0];
    if (
      !config.authToken ||
      !requestPath?.startsWith("/api/") ||
      requestPath === "/api/health" ||
      requestPath === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/traces/:traceId", async (request) => {
    const { traceId } = traceIdParams.parse(request.params);

    try {
      return {
        trace: sanitizeTrace(traceService.getTrace(traceId), sensitiveValues),
      };
    } catch (error) {
      if (error instanceof TraceNotFoundError) {
        throw new HttpError(404, "Trace not found");
      }
      throw error;
    }
  });
  app.get("/api/runs/:runId/trace", async (request) => {
    const { runId } = runTraceParams.parse(request.params);
    const trace = traceService.getTraceByRunId(runId);

    if (trace === null) {
      throw new HttpError(404, "Trace not found");
    }

    return {
      trace: sanitizeTrace(trace, sensitiveValues),
    };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
