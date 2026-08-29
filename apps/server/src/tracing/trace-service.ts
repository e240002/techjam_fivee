import { randomUUID } from "node:crypto";
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
  private readonly traces = new Map<string, Trace>();

  /**
   * Create a new trace for an Agent Run.
   */
  startTrace(input: StartTraceInput): Trace {
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

    this.traces.set(trace.id, trace);

    return trace;
  }

  /**
   * Create a new span inside an existing trace.
   */
  startSpan(input: StartSpanInput): Span {
    const trace = this.getTrace(input.traceId);

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
  }

  /**
   * Finish a span and calculate its duration.
   */
  endSpan(spanId: string, input: EndSpanInput): Span {
    const span = this.findSpan(spanId);

    const completedAt = new Date();
    const startedAt = new Date(span.startedAt);

    span.status = input.status;
    span.completedAt = completedAt.toISOString();
    span.durationMs =
      completedAt.getTime() - startedAt.getTime();

    if (input.error !== undefined) {
      span.error = input.error;
    }

    return span;
  }

  /**
   * Finish a trace.
   */
  endTrace(traceId: string, status: SpanStatus): Trace {
    const trace = this.getTrace(traceId);

    trace.status = status;
    trace.completedAt = new Date().toISOString();

    return trace;
  }

  /**
   * Add metadata to an existing span.
   *
   * Only safe, non-sensitive information should be stored here.
   */
  setSpanMetadata(
    spanId: string,
    metadata: Record<string, unknown>,
  ): Span {
    const span = this.findSpan(spanId);

    span.metadata = {
      ...span.metadata,
      ...metadata,
    };

    return span;
  }

  /**
   * Get a trace by ID.
   */
  getTrace(traceId: string): Trace {
    const trace = this.traces.get(traceId);

    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    return trace;
  }

  /**
   * Get all traces.
   */
  getTraces(): Trace[] {
    return [...this.traces.values()];
  }

  private findSpan(spanId: string): Span {
    for (const trace of this.traces.values()) {
      const span = trace.spans.find(
        (span) => span.id === spanId,
      );

      if (span) {
        return span;
      }
    }

    throw new Error(`Span not found: ${spanId}`);
  }
}

