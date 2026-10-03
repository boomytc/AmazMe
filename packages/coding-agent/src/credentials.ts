import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Credential, CredentialStore } from "@amazme/ai";

/** Credentials live outside the repo. The file is the caller's CredentialStore, not a second auth implementation. */
export class FileCredentialStore implements CredentialStore {
  /** One chain for the whole file. Provider chains would let one write clobber another. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = process.env.AMAZME_CREDENTIALS ?? join(homedir(), ".amazme", "credentials.json")) {}

  async get(providerId: string): Promise<Credential | undefined> {
    return this.read()[providerId];
  }

  set(providerId: string, credential: Credential): Promise<void> {
    return this.enqueue(async () => {
      const all = this.read();
      all[providerId] = credential;
      this.write(all);
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const all = this.read();
      delete all[providerId];
      this.write(all);
    });
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const all = this.read();
      const current = all[providerId];
      const next = await fn(current);
      if (next !== undefined) {
        all[providerId] = next;
        this.write(all);
      }
      return next ?? current;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private read(): Record<string, Credential> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private write(values: Record<string, Credential>): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${basename(this.file)}.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(values));
    renameSync(temporary, this.file);
  }
}

/** Stable installation id for ChatGPT login. This is not a token. */
export function installationDeviceId(file = process.env.AMAZME_DEVICE_ID_FILE ?? join(homedir(), ".amazme", "device-id")): string {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch {
    // create one below
  }
  const created = crypto.randomUUID();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, created);
  return created;
}
