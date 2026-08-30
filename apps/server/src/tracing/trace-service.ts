import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import type {
  Span,
  SpanStatus,
  SpanType,
  Trace,
} from "./trace-types.js";

export interface StartTraceInput {
  agentId: string;
  runId: string;
}

export interface StartSpanInput {
  traceId: string;
  type: SpanType;
  name: string;
  parentSpanId?: string | null;
}

export interface EndSpanInput {
  status: SpanStatus;
  error?: string | null;
}

export class TraceService {
  constructor(private readonly store: JsonStore) {}

  /**
   * Create and persist a new trace for an Agent Run.
   */
  async startTrace(input: StartTraceInput): Promise<Trace> {
    const now = new Date().toISOString();

    const trace: Trace = {
      id: randomUUID(),
      runId: input.runId,
      agentId: input.agentId,
      startedAt: now,
      completedAt: null,
      status: "running",
      spans: [],
    };

    await this.store.mutate((database) => {
      database.traces.push(trace);
    });

    return trace;
  }

  /**
   * Create and persist a new span inside an existing trace.
   */
  async startSpan(input: StartSpanInput): Promise<Span> {
    return this.store.mutate((database) => {
      const trace = this.findTrace(database, input.traceId);

      const span: Span = {
        id: randomUUID(),
        traceId: trace.id,
        parentSpanId: input.parentSpanId ?? null,
        type: input.type,
        name: input.name,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        durationMs: null,
        error: null,
        metadata: {},
      };

      trace.spans.push(span);
      return span;
    });
  }

  /**
   * Finish and persist a span.
   */
  async endSpan(spanId: string, input: EndSpanInput): Promise<Span> {
    return this.store.mutate((database) => {
      const span = this.findSpan(database, spanId);

      const completedAt = new Date();
      const startedAt = new Date(span.startedAt);

      span.status = input.status;
      span.completedAt = completedAt.toISOString();
      span.durationMs = completedAt.getTime() - startedAt.getTime();

      if (input.error !== undefined) {
        span.error = input.error;
      }

      return span;
    });
  }

  /**
   * Finish and persist a trace.
   */
  async endTrace(traceId: string, status: SpanStatus): Promise<Trace> {
    return this.store.mutate((database) => {
      const trace = this.findTrace(database, traceId);

      trace.status = status;
      trace.completedAt = new Date().toISOString();

      return trace;
    });
  }

  /**
   * Add safe metadata to an existing span and persist it.
   */
  async setSpanMetadata(
    spanId: string,
    metadata: Record<string, unknown>,
  ): Promise<Span> {
    return this.store.mutate((database) => {
      const span = this.findSpan(database, spanId);

      span.metadata = {
        ...span.metadata,
        ...metadata,
      };

      return span;
    });
  }

  /**
   * Get a trace by trace ID.
   */
  getTrace(traceId: string): Trace {
    const trace = this.store
      .snapshot()
      .traces.find((candidate) => candidate.id === traceId);

    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    return trace;
  }

  /**
   * Get a trace by Run ID.
   */
  getTraceByRunId(runId: string): Trace | null {
    return (
      this.store
        .snapshot()
        .traces.find((trace) => trace.runId === runId) ?? null
    );
  }

  /**
   * Get all traces.
   */
  getTraces(): Trace[] {
    return this.store.snapshot().traces;
  }

  private findTrace(database: Database, traceId: string): Trace {
    const trace = database.traces.find(
      (candidate) => candidate.id === traceId,
    );

    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    return trace;
  }

  private findSpan(database: Database, spanId: string): Span {
    for (const trace of database.traces) {
      const span = trace.spans.find(
        (candidate) => candidate.id === spanId,
      );

      if (span) {
        return span;
      }
    }

    throw new Error(`Span not found: ${spanId}`);
  }
}
