import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { TraceService } from "./tracing/trace-service.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const traceService = new TraceService(store, [
  config.arkApiKey,
  config.authToken,
]);
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner, traceService);
await service.initialize();

const app = await createApp(config, service, traceService);

let shutdownStarted = false;

const shutdown = async (signal: string) => {
  if (shutdownStarted) {
    app.log.error({ signal }, "Forcing shutdown after a second signal");
    process.exit(1);
  }
  shutdownStarted = true;
  app.log.info({ signal }, "Shutting down");

  try {
    await app.close();
    await service.shutdown();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "Graceful shutdown failed");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
