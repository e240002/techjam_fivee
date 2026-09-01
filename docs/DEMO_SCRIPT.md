# Three-minute demo script

## Before recording

- Start the local POC with Podman and the real Ark endpoint.
- Keep all credentials outside the recording frame.
- Select the Baseline Test Agent.
- Confirm Recent Runs contains a completed and a cancelled Run.
- Set browser zoom so the Playground and Trace panel are readable.
- Close unrelated windows and notifications.

Suggested live prompt:

~~~text
Reply with exactly TRACE_SUCCESS_OK.
~~~

If recording a fresh cancellation, use a task long enough to stop safely:

~~~text
Create a small TypeScript CLI with tests. Work step by step and run the tests.
~~~

## Recording

### 0:00-0:20 - Problem and result

**Screen:** Repository README, then the Agent Playground.

**Say:**

> AI Agents are difficult to trust when a Run is only visible as a final answer
> or an error. We built RunProof, lightweight Trace, Audit, and Observability
> middleware for Volc Agent Launchpad. Every real Run now leaves correlated,
> persistent, and sanitized execution evidence.

### 0:20-0:45 - Architecture

**Screen:** docs/ARCHITECTURE.md, with the Mermaid diagram visible.

**Say:**

> The React Playground calls the Fastify control plane. AgentService manages the
> Run lifecycle and emits an orchestration span plus a child model span through
> TraceService. TraceService redacts metadata before persisting it in the JSON
> store. The UI retrieves evidence by Run ID, while the Ark API key remains
> server-side.

### 0:45-1:25 - Real successful Run

**Screen:** Playground with the Agent ready.

1. Submit: Reply with exactly TRACE_SUCCESS_OK.
2. Show the Agent move from ready to busy and back to ready.
3. Open **Trace** after the response appears.

**Say:**

> This is a real end-to-end Run through Codex and Volcengine Ark. The Trace panel
> shows the terminal status, total duration, the agent.run orchestration span,
> its codex.run child span, safe event counts, model usage, and a correlated
> trace ID. The evidence survives page refreshes and service restarts.

### 1:25-2:05 - Cancellation and control

**Screen:** Trace panel and Recent Runs.

1. Select the recorded **cancelled** Run.
2. Point to both cancelled spans and their durations.
3. Close Trace and show the Agent is ready and controllable.

**Say:**

> A useful audit trail must also explain non-success outcomes. Here a Run was
> stopped while executing. Both the orchestration and model spans are marked
> cancelled, and the Agent returns to a controllable state. Recent Runs lets an
> operator compare completed, cancelled, and failed outcomes without leaving the
> Playground.

### 2:05-2:35 - Robustness and privacy

**Screen:** Trace panel metadata, then the tracing section of the README.

**Say:**

> Tracing is best-effort, so an observability write failure cannot change the
> underlying Agent result. Metadata and errors are sanitized before persistence
> and sanitized again before API responses. We deliberately do not record
> prompts, outputs, thread IDs, environment variables, or credentials.

### 2:35-3:00 - Reproducibility and close

**Screen:** README local setup and test result.

**Say:**

> A reviewer can clone the repository, set three Ark variables, and start the
> complete platform with one command. The current branch passes type checking,
> 95 automated tests, and both production builds. RunProof gives every Agent Run
> a durable, privacy-safe receipt: what happened, how it ended, and what it
> consumed, without exposing sensitive content.
