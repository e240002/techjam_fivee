# RunProof - TechJam submission

## Submission fields

- **Project:** RunProof - Privacy-Safe Observability Middleware for AI Agents
- **Track:** Agent Launchpad - Design and Build Lightweight Agent Middleware
- **Repository:** https://github.com/e240002/techjam_fivee
- **Demo:** Three-minute live walkthrough of the local POC during judging
- **Team:** Team Fivee

## One-line summary

Persistent, correlated, and privacy-aware execution traces that make successful,
failed, and cancelled AI Agent Runs inspectable from the existing Playground.

## Problem

Agent applications often expose only a prompt and a final response. When a Run
is slow, fails, or is cancelled, operators cannot easily determine which stage
was reached, how long it took, or whether the model process terminated cleanly.
Logging everything is not an acceptable answer because prompts, outputs,
credentials, and environment data may be sensitive.

## Solution

RunProof adds a lightweight observability path to Volc Agent Launchpad without
changing its execution contract. Every real Agent Run creates:

- an agent.run orchestration span;
- a correlated codex.run child span;
- terminal status and duration;
- safe structural event counts and model usage; and
- a persistent trace ID retrievable by Run ID or trace ID.

The Playground's Trace panel renders the span hierarchy and lets operators switch
among recent completed, cancelled, and failed Runs.

## Architecture and design

~~~text
React Playground
       |
    Fastify API -------- trace retrieval
       |                       |
  AgentService ---------- TraceService
       |                       |
   AgentRunner          sanitize + persist
       |                       |
Codex + Volcengine Ark ------ JSON store
~~~

AgentService owns lifecycle coordination. TraceService is a focused middleware
component responsible for trace creation, span transitions, sanitization,
persistence, and retrieval. Both local-container and ECS runner paths report
through the same service, keeping the feature independent of the runtime
provider.

Full architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
One-page diagram: [runproof-architecture.png](assets/runproof-architecture.png)

## End-to-end behavior

The implementation has been exercised with the real Volcengine Ark Responses
API:

- a successful Run returned the expected response and persisted completed
  orchestration/model spans;
- a stopped Run persisted cancelled spans and returned the Agent to ready; and
- the UI retrieved historical evidence and switched between terminal outcomes.

The trace APIs are:

- GET /api/runs/:runId/trace
- GET /api/traces/:traceId

## Robustness and safety

- Trace writes are best-effort and cannot change the Agent Run result.
- Active Runs are reconciled to cancelled after service restart.
- Process termination escalates after a grace period.
- Trace metadata and errors are sanitized before storage and before API output.
- Prompts, outputs, Codex thread IDs, environment variables, and credentials are
  excluded from trace metadata.
- Trace output remains protected by the application's existing API
  authentication when enabled.
- Persistence uses the existing serialized, atomic JSON-store write path.

## Reproduction

Requirements: Node.js 22+, npm 10+, Podman or Docker, and a valid Ark API key
and endpoint.

~~~bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3 \
npm run poc
~~~

Open http://localhost:3000, select or create an Agent, run a real task, and
open **Trace**. Stop a longer task to generate cancelled evidence, then use
**Recent Runs** to compare the two outcomes.
