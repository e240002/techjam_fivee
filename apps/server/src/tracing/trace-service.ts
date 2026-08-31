import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import type {
  Span,
  SpanStatus,
  SpanType,
  Trace,
} from "./trace-types.js";
import { sanitizeMetadata, sanitizeText } from "./redaction.js";

export class TraceNotFoundError extends Error {
  constructor(traceId: string) {
    super(`Trace not found: ${traceId}`);
    this.name = "TraceNotFoundError";
  }
}

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
  completedAt?: string;
}

export interface FinalizeTraceInput {
  status: SpanStatus;
  error?: string | null;
  completedAt?: string;
}

export class TraceService {
  constructor(
    private readonly store: JsonStore,
    private readonly sensitiveValues: readonly string[] = [],
  ) {}

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

      this.completeSpan(span, input, this.parseCompletedAt(input.completedAt));

      return span;
    });
  }

  /**
   * Atomically close a trace and every span that is still running. This keeps
   * the trace internally consistent even if the durable write fails.
   */
  async finalizeTrace(
    traceId: string,
    input: FinalizeTraceInput,
  ): Promise<Trace> {
    return this.store.mutate((database) => {
      const trace = this.findTrace(database, traceId);
      const completedAt = this.parseCompletedAt(input.completedAt);

      for (const span of trace.spans) {
        span.metadata = sanitizeMetadata(span.metadata, this.sensitiveValues);

        if (span.status === "running") {
          this.completeSpan(span, input, completedAt);
        } else if (span.error !== null) {
          span.error = sanitizeText(span.error, this.sensitiveValues);
        }
      }

      trace.status = input.status;
      trace.completedAt = completedAt.toISOString();

      return trace;
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

      span.metadata = sanitizeMetadata(
        {
          ...span.metadata,
          ...metadata,
        },
        this.sensitiveValues,
      );

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
      throw new TraceNotFoundError(traceId);
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

  private parseCompletedAt(value?: string): Date {
    const parsed = value === undefined ? new Date() : new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private completeSpan(
    span: Span,
    input: EndSpanInput | FinalizeTraceInput,
    completedAt: Date,
  ): void {
    const startedAt = new Date(span.startedAt);
    const durationMs = completedAt.getTime() - startedAt.getTime();

    span.status = input.status;
    span.completedAt = completedAt.toISOString();
    span.durationMs = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;

    if (input.error !== undefined) {
      span.error =
        input.error === null
          ? null
          : sanitizeText(input.error, this.sensitiveValues);
    } else if (span.error !== null) {
      span.error = sanitizeText(span.error, this.sensitiveValues);
    }
  }
}
