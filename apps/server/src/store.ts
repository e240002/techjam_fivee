import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  traces: [],
});

interface SerializedDatabase {
  committed: Database;
  contents: string;
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

function serializeDatabase(data: Database): SerializedDatabase {
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) {
    throw new TypeError("Database is not JSON-serializable");
  }
  return {
    committed: JSON.parse(json) as Database,
    contents: json + "\n",
  };
}

function normalizeMutationResult<T>(value: T): T {
  // Void mutations are a supported and common call pattern.
  if (value === undefined) return value;

  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Mutation result is not JSON-serializable");
  }
  return JSON.parse(json) as T;
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = {
        ...parsed,
        traces: Array.isArray(parsed.traces) ? parsed.traces : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  /**
   * Return a detached clone of only the selected records. This keeps frequent
   * read paths from cloning the entire database while preserving snapshot
   * isolation for callers.
   */
  select<T>(
    selector: (database: DeepReadonly<Database>) => T,
  ): DeepMutable<T> {
    const selected = selector(this.data as DeepReadonly<Database>);
    return structuredClone(selected) as DeepMutable<T>;
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const mutationResult = await mutation(next);
      const { committed, contents } = serializeDatabase(next);
      const returned = normalizeMutationResult(mutationResult);
      await this.persistContents(contents);
      this.data = committed;
      result = returned;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const { contents } = serializeDatabase(data);
    await this.persistContents(contents);
  }

  private async persistContents(contents: string): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
