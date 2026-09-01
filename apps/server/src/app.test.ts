import { describe, expect, it } from "vitest";
import { createApp, type TraceQueryService } from "./app.js";
import type { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { Trace } from "./tracing/trace-types.js";
import { TraceNotFoundError } from "./tracing/trace-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const traceId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

const trace: Trace = {
  id: traceId,
  runId,
  agentId: "33333333-3333-4333-8333-333333333333",
  startedAt: "2026-08-30T08:00:00.000Z",
  completedAt: "2026-08-30T08:00:01.000Z",
  status: "failed",
  spans: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      traceId,
      parentSpanId: null,
      type: "model",
      name: "model request",
      status: "failed",
      startedAt: "2026-08-30T08:00:00.000Z",
      completedAt: "2026-08-30T08:00:01.000Z",
      durationMs: 1000,
      error: "Authorization: Bearer secret-token",
      metadata: {
        apiKey: "secret-api-key",
        prompt: "private prompt",
        inputTokens: 12,
      },
    },
  ],
};

const traceService: TraceQueryService = {
  getTrace: (requestedTraceId) => {
    if (requestedTraceId !== traceId) {
      throw new TraceNotFoundError(requestedTraceId);
    }
    return structuredClone(trace);
  },
  getTraceByRunId: (requestedRunId) =>
    requestedRunId === runId ? structuredClone(trace) : null,
};

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
      traceService,
    );

    const denied = await app.inject({
      method: "GET",
      url: "/api/agents",
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: {
        authorization: "Bearer a-strong-test-token",
      },
    });
    expect(allowed.statusCode).toBe(200);

    const deniedTrace = await app.inject({
      method: "GET",
      url: `/api/traces/${traceId}`,
    });
    expect(deniedTrace.statusCode).toBe(401);

    const allowedTrace = await app.inject({
      method: "GET",
      url: `/api/traces/${traceId}`,
      headers: {
        authorization: "Bearer a-strong-test-token",
      },
    });
    expect(allowedTrace.statusCode).toBe(200);

    const healthWithQuery = await app.inject({
      method: "GET",
      url: "/api/health?probe=ready",
    });
    expect(healthWithQuery.statusCode).toBe(200);

    const authWithQuery = await app.inject({
      method: "GET",
      url: "/api/auth?nonce=test",
    });
    expect(authWithQuery.statusCode).toBe(200);

    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      traceService,
    );

    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        "content-type": "application/json",
      },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        name: "x".repeat(1_100_000),
      }),
    });
    expect(oversized.statusCode).toBe(413);

    await app.close();
  });

  it("does not expose unexpected internal error details", async () => {
    const configuredSecret = "internal-configured-secret";
    const failingService = {
      ...service,
      systemInfo: async () => {
        throw new Error(`provider failed with ${configuredSecret}`);
      },
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        ARK_API_KEY: configuredSecret,
      }),
      failingService,
      traceService,
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/system",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(response.body).not.toContain(configuredSecret);
    await app.close();
  });

  it("preserves intentional operator guidance on service errors", async () => {
    const guidance = "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.";
    const unavailableService = {
      ...service,
      listAgents: () => {
        throw new HttpError(503, guidance);
      },
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      unavailableService,
      traceService,
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: guidance });
    await app.close();
  });

  it("retrieves traces by trace ID and run ID without exposing secrets", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      traceService,
    );

    const byTraceId = await app.inject({
      method: "GET",
      url: `/api/traces/${traceId}`,
    });

    expect(byTraceId.statusCode).toBe(200);
    expect(byTraceId.json()).toMatchObject({
      trace: {
        id: traceId,
        runId,
        spans: [
          {
            error: "Authorization=[REDACTED]",
            metadata: {
              apiKey: "[REDACTED]",
              prompt: "[REDACTED]",
              inputTokens: 12,
            },
          },
        ],
      },
    });

    expect(byTraceId.body).not.toContain("secret-token");
    expect(byTraceId.body).not.toContain("secret-api-key");
    expect(byTraceId.body).not.toContain("private prompt");

    const byRunId = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/trace`,
    });

    expect(byRunId.statusCode).toBe(200);
    expect(byRunId.json()).toMatchObject({
      trace: {
        id: traceId,
        runId,
      },
    });

    await app.close();
  });

  it("scrubs exact configured secrets from legacy trace responses", async () => {
    const configuredSecret = "legacy-bare-configured-secret";
    const legacyTraceService: TraceQueryService = {
      getTrace: () => ({
        ...structuredClone(trace),
        spans: [
          {
            ...structuredClone(trace.spans[0]!),
            error: `provider rejected ${configuredSecret}`,
            metadata: { detail: `failure ${configuredSecret}` },
          },
        ],
      }),
      getTraceByRunId: () => null,
    };
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: configuredSecret,
      }),
      service,
      legacyTraceService,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/traces/${traceId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(configuredSecret);
    expect(response.body).toContain("[REDACTED]");
    await app.close();
  });

  it("returns client errors for malformed or unknown trace identifiers", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      traceService,
    );

    const malformedTrace = await app.inject({
      method: "GET",
      url: "/api/traces/not-a-uuid",
    });
    expect(malformedTrace.statusCode).toBe(400);

    const malformedRun = await app.inject({
      method: "GET",
      url: "/api/runs/not-a-uuid/trace",
    });
    expect(malformedRun.statusCode).toBe(400);

    const missingTrace = await app.inject({
      method: "GET",
      url: "/api/traces/55555555-5555-4555-8555-555555555555",
    });
    expect(missingTrace.statusCode).toBe(404);
    expect(missingTrace.json()).toEqual({
      error: "Trace not found",
    });

    const missingRun = await app.inject({
      method: "GET",
      url: "/api/runs/66666666-6666-4666-8666-666666666666/trace",
    });
    expect(missingRun.statusCode).toBe(404);
    expect(missingRun.json()).toEqual({
      error: "Trace not found",
    });

    await app.close();
  });
});
