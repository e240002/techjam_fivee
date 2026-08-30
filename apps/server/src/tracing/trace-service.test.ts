import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { TraceService } from "./trace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeTraceService(): Promise<TraceService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-trace-test-"));
  temporaryDirectories.push(root);

  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();

  return new TraceService(store);
}

describe("TraceService retrieval contract", () => {
  it("correlates a trace with its agent and run IDs", async () => {
    const service = await makeTraceService();
    const agentId = randomUUID();
    const runId = randomUUID();

    const created = await service.startTrace({ agentId, runId });
    const retrieved = service.getTrace(created.id);

    expect(retrieved).toMatchObject({
      id: created.id,
      agentId,
      runId,
      status: "running",
    });
  });

  it("preserves parent-child span relationships", async () => {
    const service = await makeTraceService();
    const trace = await service.startTrace({
      agentId: randomUUID(),
      runId: randomUUID(),
    });

    const parent = await service.startSpan({
      traceId: trace.id,
      type: "orchestration",
      name: "agent run",
    });

    const child = await service.startSpan({
      traceId: trace.id,
      parentSpanId: parent.id,
      type: "model",
      name: "model request",
    });

    const retrieved = service.getTrace(trace.id);

    expect(retrieved.spans).toHaveLength(2);
    expect(retrieved.spans[1]).toMatchObject({
      id: child.id,
      traceId: trace.id,
      parentSpanId: parent.id,
      type: "model",
    });
  });

  it("rejects unknown trace IDs", async () => {
    const service = await makeTraceService();
    const missingId = randomUUID();

    expect(() => service.getTrace(missingId)).toThrow(
      `Trace not found: ${missingId}`,
    );
  });
});

describe("TraceService persistence", () => {
  it("persists traces across store restart and retrieves them by id and run id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-trace-test-"));
    temporaryDirectories.push(root);

    const databasePath = path.join(root, "db.json");

    const firstStore = new JsonStore(databasePath);
    await firstStore.initialize();

    const firstTraceService = new TraceService(firstStore);

    const trace = await firstTraceService.startTrace({
      agentId: "agent-1",
      runId: "run-1",
    });

    const span = await firstTraceService.startSpan({
      traceId: trace.id,
      type: "tool",
      name: "example-tool-call",
    });

    await firstTraceService.setSpanMetadata(span.id, {
      toolName: "example-tool",
    });

    await firstTraceService.endSpan(span.id, {
      status: "completed",
    });

    await firstTraceService.endTrace(trace.id, "completed");

    const secondStore = new JsonStore(databasePath);
    await secondStore.initialize();

    const secondTraceService = new TraceService(secondStore);

    const byId = secondTraceService.getTrace(trace.id);
    expect(byId.id).toBe(trace.id);
    expect(byId.runId).toBe("run-1");
    expect(byId.agentId).toBe("agent-1");
    expect(byId.status).toBe("completed");
    expect(byId.spans).toHaveLength(1);
    expect(byId.spans[0]?.status).toBe("completed");
    expect(byId.spans[0]?.metadata).toEqual({
      toolName: "example-tool",
    });

    const byRunId = secondTraceService.getTraceByRunId("run-1");
    expect(byRunId?.id).toBe(trace.id);

    const allTraces = secondTraceService.getTraces();
    expect(allTraces).toHaveLength(1);
    expect(allTraces[0]?.id).toBe(trace.id);
  });

  it("returns null when no trace exists for a run id", async () => {
    const traceService = await makeTraceService();

    expect(traceService.getTraceByRunId("missing-run")).toBeNull();
  });
});