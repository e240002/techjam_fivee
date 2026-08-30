import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TraceService } from "./trace-service.js";

describe("TraceService retrieval contract", () => {
  it("correlates a trace with its agent and run IDs", () => {
    const service = new TraceService();
    const agentId = randomUUID();
    const runId = randomUUID();

    const created = service.startTrace({ agentId, runId });
    const retrieved = service.getTrace(created.id);

    expect(retrieved).toMatchObject({
      id: created.id,
      agentId,
      runId,
      status: "running",
    });
  });

  it("preserves parent-child span relationships", () => {
    const service = new TraceService();
    const trace = service.startTrace({
      agentId: randomUUID(),
      runId: randomUUID(),
    });

    const parent = service.startSpan({
      traceId: trace.id,
      type: "orchestration",
      name: "agent run",
    });

    const child = service.startSpan({
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

  it("rejects unknown trace IDs", () => {
    const service = new TraceService();
    const missingId = randomUUID();

    expect(() => service.getTrace(missingId)).toThrow(
      `Trace not found: ${missingId}`,
    );
  });
});