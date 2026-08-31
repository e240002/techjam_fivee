import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import type { Database } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("does not publish live references after a successful mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const store = new JsonStore(databasePath);
    await store.initialize();

    const externalMessage = {
      id: "message-1",
      agentId: "agent-1",
      runId: "run-1",
      role: "user" as const,
      content: "persisted content",
      createdAt: new Date().toISOString(),
    };
    let retainedDatabase: Database | null = null;

    const returnedMessage = await store.mutate((database) => {
      retainedDatabase = database;
      database.messages.push(externalMessage);
      return database.messages[0]!;
    });

    externalMessage.content = "mutated through the input";
    returnedMessage.content = "mutated through the result";
    if (retainedDatabase === null) throw new Error("Mutation did not run");
    retainedDatabase.messages[0]!.content = "mutated through the callback";

    expect(store.snapshot().messages[0]?.content).toBe("persisted content");

    const reloaded = new JsonStore(databasePath);
    await reloaded.initialize();
    expect(reloaded.snapshot().messages[0]?.content).toBe("persisted content");
  });

  it("loads an existing database without traces and preserves existing data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);

    const databasePath = path.join(root, "db.json");

    const existingMessage = {
      id: "existing-message",
      agentId: "existing-agent",
      runId: "existing-run",
      role: "user" as const,
      content: "existing data must survive",
      createdAt: "2026-08-30T00:00:00.000Z",
    };

    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [existingMessage],
        runs: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot()).toEqual({
      version: 1,
      agents: [],
      messages: [existingMessage],
      runs: [],
      traces: [],
    });
  });

});
