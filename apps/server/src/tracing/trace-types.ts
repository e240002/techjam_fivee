export type SpanStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SpanType =
  | "orchestration"
  | "model"
  | "tool"
  | "workspace"
  | "policy"
  | "sandbox";

export interface Trace {
  id: string;
  runId: string;
  agentId: string;

  startedAt: string;
  completedAt: string | null;

  status: SpanStatus;

  spans: Span[];
}

export interface Span {
  id: string;
  traceId: string;
  parentSpanId: string | null;

  type: SpanType;
  name: string;

  status: SpanStatus;

  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;

  error: string | null;

  metadata: Record<string, unknown>;
}