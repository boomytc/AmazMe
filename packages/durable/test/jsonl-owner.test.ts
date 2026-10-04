import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync, chmodSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { value } from "@amazme/durable";
import { JsonlStorage, openJsonlOwner, StorageBusyError, type JsonlOwner } from "@amazme/durable/storage/jsonl/node";
import { canonicalStoragePath, lockHomeDirectory, pathLockDirectory } from "../src/storage/jsonl-lock.ts";

const childSource = `
import { openJsonlOwner } from "@amazme/durable/storage/jsonl/node";
const file = process.env.AMAZME_JSONL_FILE;
if (!file) throw new Error("missing AMAZME_JSONL_FILE");
const owner = openJsonlOwner(file);
process.send({ type: "held", pid: process.pid });
for (;;) {
  const message = await new Promise((resolve) => process.once("message", resolve));
  if (!message || message.type === "quit") break;
  if (message.type === "release") {
    await owner.release();
    process.send({ type: "released" });
  }
}
`;

interface Holder {
  pid: number;
  release(): Promise<void>;
  quit(): Promise<void>;
  kill(): Promise<void>;
}

function sandbox(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "amazme-jsonl-owner-"));
  const file = join(dir, "storage.jsonl");
  const owners: JsonlOwner[] = [];
  const children: ChildProcess[] = [];
  const finished = new WeakSet<ChildProcess>();
  const beforeCleanup: Array<() => Promise<void> | void> = [];
  t.after(async () => {
    await Promise.all(children.map(async (child) => {
      if (finished.has(child)) return;
      const done = once(child, "exit");
      if (!finished.has(child)) child.kill("SIGKILL");
      if (!finished.has(child)) await done;
    }));
    for (const run of beforeCleanup) await run();
    for (const owner of owners) {
      try { await owner.release(); } catch { /* the test already released it, or release is still failing */ }
    }
    try {
      const leftover = openJsonlOwner(file);
      await leftover.release();
    } catch { /* a foreign lock or a broken path is removed with the temp directory when it lives there */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    file,
    own<T extends JsonlOwner>(owner: T): T {
      owners.push(owner);
      return owner;
    },
    track(child: ChildProcess): ChildProcess {
      children.push(child);
      child.once("exit", () => finished.add(child));
      return child;
    },
    beforeCleanup(run: () => Promise<void> | void) { beforeCleanup.push(run); },
  };
}

function lockDirsHeldBy(pid: number): string[] {
  const root = lockHomeDirectory();
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "owner") {
        try {
          const record = JSON.parse(readFileSync(full, "utf8")) as { pid?: unknown };
          if (record.pid === pid) found.push(current);
        } catch {
          // An unreadable residue is not this pid's lock.
        }
      }
    }
  }
  return found;
}

function hold(file: string, box: ReturnType<typeof sandbox>, environment: Record<string, string> = {}): Promise<Holder> {
  let stderr = "";
  const child = box.track(spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, AMAZME_JSONL_FILE: file },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const messages: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  let exited: number | null | undefined;
  const exitWaiters: Array<(code: number | null) => void> = [];
  child.on("message", (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  child.once("exit", (code) => {
    exited = code;
    for (const waiter of exitWaiters.splice(0)) waiter(code);
  });
  const nextMessage = (): Promise<unknown> => {
    const queued = messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      if (exited !== undefined) {
        finish(new Error(`child exited ${exited}\n${stderr}`));
        return;
      }
      waiters.push((value) => finish(undefined, value));
      exitWaiters.push((code) => finish(new Error(`child exited ${code}\n${stderr}`)));
    });
  };
  const expectType = async (type: string): Promise<unknown> => {
    const message = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`timed out waiting for ${type}\n${stderr}`));
      }, 20_000);
      nextMessage().then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal((message as { type?: string } | undefined)?.type, type, stderr);
    return message;
  };
  const ready = expectType("held").then((message) => {
    const pid = (message as { pid?: unknown }).pid;
    assert.equal(typeof pid, "number");
    return pid as number;
  });
  return ready.then((pid) => ({
    pid,
    async release() { child.send({ type: "release" }); await expectType("released"); },
    async quit() {
      if (exited !== undefined || child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise<void>((resolve) => { exitWaiters.push(() => resolve()); });
      child.send({ type: "quit" });
      if (exited !== undefined || child.exitCode !== null || child.signalCode !== null) return;
      await done;
    },
    async kill() {
      if (exited !== undefined || child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise<void>((resolve) => { exitWaiters.push(() => resolve()); });
      const signaled = child.kill("SIGKILL");
      if (!signaled && exited === undefined && child.exitCode === null && child.signalCode === null) {
        throw new Error(`could not signal child ${child.pid}\n${stderr}`);
      }
      if (exited !== undefined || child.exitCode !== null || child.signalCode !== null) return;
      await done;
    },
  }));
}

function busy(error: unknown): boolean {
  assert.ok(error instanceof StorageBusyError);
  assert.equal(error.code, "storage_busy");
  return true;
}

test("a second owner in this process is rejected until release", (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  assert.throws(() => openJsonlOwner(box.file), busy);
  return owner.release().then(() => {
    const next = box.own(openJsonlOwner(box.file));
    return next.release();
  });
});

test("a second process cannot open the same file", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "");
  const holder = await hold(box.file, box);
  assert.throws(() => openJsonlOwner(box.file), busy);
  await holder.release();
  await holder.quit();
  const owner = box.own(openJsonlOwner(box.file));
  await owner.release();
});

test("HOME and TMPDIR cannot split cross-process writer exclusion", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  const otherHome = join(box.dir, "home");
  const otherTmp = join(box.dir, "tmp");
  mkdirSync(otherHome);
  mkdirSync(otherTmp);
  await assert.rejects(hold(box.file, box, { HOME: otherHome, TMPDIR: otherTmp }), /storage is busy/);
  await owner.storage.commit([{ type: "set", address: value("box"), value: 2 }]);
  await owner.release();
  const next = await hold(box.file, box, { HOME: otherHome, TMPDIR: otherTmp });
  await next.release();
  await next.quit();
});

test("lock directories are private to the account", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  const root = lockHomeDirectory();
  for (const dir of [root, join(root, "path"), join(root, "inode"), ...lockDirsHeldBy(process.pid)]) {
    const stat = statSync(dir);
    assert.equal(stat.uid, userInfo().uid);
    assert.equal(stat.mode & 0o077, 0);
  }
  await owner.release();
});

test("owned reads and writes fail closed when a lock is replaced", async (t) => {
  const box = sandbox(t);
  const before = new Set(lockDirsHeldBy(process.pid));
  const owner = box.own(openJsonlOwner(box.file));
  await owner.storage.commit([{ type: "set", address: value("box"), value: 1 }]);
  for (const dir of lockDirsHeldBy(process.pid).filter((dir) => !before.has(dir))) rmSync(dir, { recursive: true });
  const next = await hold(box.file, box);
  await assert.rejects(owner.storage.read((view) => view.version()), busy);
  await assert.rejects(owner.storage.commit([{ type: "set", address: value("box"), value: 2 }]), busy);
  await assert.rejects(owner.deleteData(), busy);
  await owner.release();
  assert.throws(() => openJsonlOwner(box.file), busy);
  assert.equal(readFileSync(box.file, "utf8").includes('"value":2'), false);
  await next.release();
  await next.quit();
});

test("owned writes refuse a lock whose permissions become public", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  const pathDir = pathLockDirectory(canonicalStoragePath(box.file));
  box.beforeCleanup(() => { if (existsSync(pathDir)) chmodSync(pathDir, 0o700); });
  chmodSync(pathDir, 0o755);
  await assert.rejects(owner.storage.commit([{ type: "set", address: value("box"), value: 2 }]), busy);
  assert.equal(readFileSync(box.file, "utf8"), "");
  chmodSync(pathDir, 0o700);
  await owner.release();
});

test("delete rechecks ownership after waiting for admitted storage work", async (t) => {
  const box = sandbox(t);
  const before = new Set(lockDirsHeldBy(process.pid));
  const owner = box.own(openJsonlOwner(box.file));
  let releaseWork!: () => void;
  const work = new Promise<void>((resolve) => { releaseWork = resolve; });
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  box.beforeCleanup(() => releaseWork());
  const running = owner.storage.run(async () => { started(); await work; });
  await admitted;
  const deleting = owner.deleteData();
  for (const dir of lockDirsHeldBy(process.pid).filter((dir) => !before.has(dir))) rmSync(dir, { recursive: true });
  const next = await hold(box.file, box);
  releaseWork();
  await running;
  await assert.rejects(deleting, busy);
  assert.equal(existsSync(box.file), true);
  await owner.release();
  assert.throws(() => openJsonlOwner(box.file), busy);
  await next.release();
  await next.quit();
});

test("a live owner is not replaced when its lock is old", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "");
  const holder = await hold(box.file, box);
  const dirs = lockDirsHeldBy(holder.pid);
  assert.equal(dirs.length, 2);
  const old = new Date(0);
  const snapshots = new Map(dirs.map((dir) => [dir, readFileSync(join(dir, "owner"), "utf8")]));
  for (const dir of dirs) {
    utimesSync(dir, old, old);
    utimesSync(join(dir, "owner"), old, old);
  }
  assert.throws(() => openJsonlOwner(box.file), busy);
  for (const [dir, text] of snapshots) assert.equal(readFileSync(join(dir, "owner"), "utf8"), text);
  await holder.release();
  await holder.quit();
  const owner = box.own(openJsonlOwner(box.file));
  await owner.release();
});

test("a killed owner can be replaced after its pid is gone", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "{\"writes\":[]}\n");
  const holder = await hold(box.file, box);
  await holder.kill();
  const owner = box.own(openJsonlOwner(box.file));
  await owner.storage.commit([{ type: "set", address: value("box"), value: 1 }]);
  assert.equal(await owner.storage.read((view) => view.get(value("box"))), 1);
  await owner.release();
});

test("an insecure dead lock is refused without reclaiming its owner record", async (t) => {
  const box = sandbox(t);
  const holder = await hold(box.file, box);
  const pathDir = pathLockDirectory(canonicalStoragePath(box.file));
  const record = readFileSync(join(pathDir, "owner"), "utf8");
  await holder.kill();
  box.beforeCleanup(() => { if (existsSync(pathDir)) chmodSync(pathDir, 0o700); });
  chmodSync(pathDir, 0o755);
  assert.throws(() => openJsonlOwner(box.file), busy);
  assert.equal(readFileSync(join(pathDir, "owner"), "utf8"), record);
  chmodSync(pathDir, 0o700);
  const owner = box.own(openJsonlOwner(box.file));
  await owner.release();
});

test("a previous process cannot release the lock it already handed off", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "");
  const holder = await hold(box.file, box);
  await holder.release();
  const owner = box.own(openJsonlOwner(box.file));
  await holder.release();
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.storage.commit([{ type: "set", address: value("box"), value: 4 }]);
  await holder.quit();
  assert.equal(await owner.storage.read((view) => view.get(value("box"))), 4);
  await owner.release();
});

test("an owner does not remove a lock token it does not hold", async (t) => {
  const box = sandbox(t);
  const before = new Set(lockDirsHeldBy(process.pid));
  const owner = box.own(openJsonlOwner(box.file));
  const mine = lockDirsHeldBy(process.pid).filter((dir) => !before.has(dir));
  assert.equal(mine.length, 2);
  const replacement = JSON.stringify({ token: "other", pid: process.pid, hostname: "other-host" });
  for (const dir of mine) writeFileSync(join(dir, "owner"), replacement);
  box.beforeCleanup(() => {
    for (const dir of mine) rmSync(dir, { recursive: true, force: true });
  });
  await owner.release();
  for (const dir of mine) assert.equal(readFileSync(join(dir, "owner"), "utf8"), replacement);
  assert.throws(() => openJsonlOwner(box.file), busy);
});

test("a symlink and its target share one writer", async (t) => {
  const box = sandbox(t);
  const target = join(box.dir, "target.jsonl");
  const link = join(box.dir, "link.jsonl");
  writeFileSync(target, "");
  symlinkSync(target, link);
  const owner = box.own(openJsonlOwner(link));
  await owner.storage.commit([{ type: "set", address: value("box"), value: 7 }]);
  assert.throws(() => openJsonlOwner(target), busy);
  await owner.release();
  const reopened = box.own(openJsonlOwner(target));
  assert.equal(await reopened.storage.read((view) => view.get(value("box"))), 7);
  await reopened.release();
});

test("a broken symlink is refused without creating a file", (t) => {
  const box = sandbox(t);
  const link = join(box.dir, "broken.jsonl");
  symlinkSync(join(box.dir, "missing.jsonl"), link);
  assert.throws(() => openJsonlOwner(link), (error: unknown) => {
    assert.equal(error instanceof StorageBusyError, false);
    assert.match((error as Error).message, /broken symlink/);
    return true;
  });
  assert.equal(existsSync(join(box.dir, "missing.jsonl")), false);
});

test("a relative path and its absolute path share one writer", (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(relative(process.cwd(), box.file)));
  assert.throws(() => openJsonlOwner(box.file), busy);
  return owner.release();
});

test("a hard link cannot open a second writer and does not keep a lock", async (t) => {
  const box = sandbox(t);
  const otherDir = mkdtempSync(join(tmpdir(), "amazme-jsonl-link-"));
  t.after(() => rmSync(otherDir, { recursive: true, force: true }));
  const link = join(otherDir, "hard.jsonl");
  writeFileSync(box.file, "");
  linkSync(box.file, link);
  const owner = box.own(openJsonlOwner(box.file));
  appendFileSync(box.file, "{\"torn\"");
  const snapshot = readFileSync(box.file);
  assert.throws(() => openJsonlOwner(link), busy);
  assert.deepEqual(readFileSync(box.file), snapshot);
  await owner.release();
  const reopened = box.own(openJsonlOwner(link));
  assert.equal(readFileSync(box.file, "utf8").includes("torn"), false);
  await reopened.release();
});

test("another process does not repair a torn tail, and the holder can hand it off", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "{\"writes\":[]}\n");
  const holder = await hold(box.file, box);
  appendFileSync(box.file, "{\"torn\"");
  const snapshot = readFileSync(box.file);
  assert.throws(() => openJsonlOwner(box.file), busy);
  assert.deepEqual(readFileSync(box.file), snapshot);
  await holder.release();
  await holder.quit();
  const owner = box.own(openJsonlOwner(box.file));
  assert.equal(readFileSync(box.file, "utf8"), "{\"writes\":[]}\n");
  await owner.release();
});

test("a constructor failure releases the lock", (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "{\"writes\":null}\n");
  assert.throws(() => openJsonlOwner(box.file), (error: unknown) => {
    assert.equal(error instanceof StorageBusyError, false);
    return true;
  });
  assert.throws(() => openJsonlOwner(box.file), (error: unknown) => {
    assert.equal(error instanceof StorageBusyError, false);
    return true;
  });
  writeFileSync(box.file, "");
  const owner = box.own(openJsonlOwner(box.file));
  return owner.release();
});

test("close waits for admitted work, rejects new work, and keeps the lock", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  let releaseWork: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseWork = resolve; });
  box.beforeCleanup(() => releaseWork?.());
  let admitted = false;
  const running = owner.storage.run(async (_view, apply) => {
    await gate;
    admitted = true;
    apply([{ type: "set", address: value("box"), value: 1 }]);
  });
  let queued = false;
  const waiting = owner.storage.run(() => { queued = true; });
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  const rejected = assert.rejects(owner.storage.commit([{ type: "set", address: value("box"), value: 2 }]), /storage is closed/);
  let closed = false;
  void closing.then(() => { closed = true; }, () => undefined);
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(admitted, false);
  assert.equal(queued, false);
  assert.throws(() => openJsonlOwner(box.file), busy);
  releaseWork?.();
  await running;
  await waiting;
  await closing;
  await rejected;
  assert.equal(admitted, true);
  assert.equal(queued, true);
  const text = readFileSync(box.file, "utf8");
  assert.equal(text.includes("\"value\":2"), false);
  assert.equal(text.includes("\"value\":1"), true);
  const stopped = owner.storage.close();
  assert.equal(owner.storage.close(), stopped);
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.release();
  const reopened = box.own(openJsonlOwner(box.file));
  assert.equal(await reopened.storage.read((view) => view.get(value("box"))), 1);
  await reopened.release();
});

test("close really closes the owned file descriptor before unlock", async (t) => {
  if (process.platform === "win32" || !existsSync("/dev/fd")) {
    t.skip("descriptor enumeration requires /dev/fd");
    return;
  }
  const box = sandbox(t);
  const openDescriptors = () => new Set(readdirSync("/dev/fd").map(Number).filter((fd) => {
    try { fstatSync(fd); return true; } catch { return false; }
  }));
  const before = openDescriptors();
  const owner = box.own(openJsonlOwner(box.file));
  const added = [...openDescriptors()].filter((fd) => !before.has(fd));
  assert.equal(added.length, 1);
  const fd = added[0];
  assert.notEqual(fd, undefined);
  assert.equal(fstatSync(fd!).ino, statSync(box.file).ino);
  await owner.close();
  assert.throws(() => fstatSync(fd!), (error: unknown) => (error as NodeJS.ErrnoException).code === "EBADF");
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.release();
});

test("a failed close keeps ownership and can be retried", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  const whenIdle = owner.storage.whenIdle.bind(owner.storage);
  let attempts = 0;
  owner.storage.whenIdle = () => ++attempts === 1 ? Promise.reject(new Error("idle failed")) : whenIdle();
  await assert.rejects(owner.close(), /idle failed/);
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.close();
  assert.equal(attempts, 2);
  await owner.release();
});

test("deleteData waits, keeps the lock, and does not unlink a replaced inode", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  let releaseWork: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseWork = resolve; });
  box.beforeCleanup(() => releaseWork?.());
  const running = owner.storage.run(() => gate);
  const deleting = owner.deleteData();
  let deleted = false;
  void deleting.then(() => { deleted = true; }, () => { deleted = true; });
  await Promise.resolve();
  assert.equal(deleted, false);
  assert.throws(() => openJsonlOwner(box.file), busy);
  unlinkSync(box.file);
  writeFileSync(box.file, "replacement\n");
  releaseWork?.();
  await running;
  await deleting;
  assert.equal(readFileSync(box.file, "utf8"), "replacement\n");
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.release();
});

test("owned I/O stays on its locked inode after the path is replaced", async (t) => {
  const box = sandbox(t);
  const oldLink = join(box.dir, "old.jsonl");
  const newLink = join(box.dir, "new.jsonl");
  const first = box.own(openJsonlOwner(box.file));
  linkSync(box.file, oldLink);
  unlinkSync(box.file);
  writeFileSync(box.file, "");
  linkSync(box.file, newLink);
  const second = box.own(openJsonlOwner(newLink));
  await first.storage.commit([{ type: "set", address: value("first"), value: 1 }]);
  await second.storage.commit([{ type: "set", address: value("second"), value: 2 }]);
  assert.equal(readFileSync(oldLink, "utf8").includes('"namespace":"first"'), true);
  assert.equal(readFileSync(box.file, "utf8").includes('"namespace":"first"'), false);
  assert.equal(readFileSync(box.file, "utf8").includes('"namespace":"second"'), true);
  assert.throws(() => openJsonlOwner(oldLink), busy);
  await first.deleteData();
  assert.equal(existsSync(box.file), true);
  await first.release();
  await second.release();
});

test("a failed delete keeps the lock and a later delete removes the file", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  box.beforeCleanup(() => chmodSync(box.dir, 0o755));
  chmodSync(box.dir, 0o555);
  await assert.rejects(owner.deleteData());
  assert.equal(existsSync(box.file), true);
  assert.throws(() => openJsonlOwner(box.file), busy);
  chmodSync(box.dir, 0o755);
  await owner.deleteData();
  assert.equal(existsSync(box.file), false);
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.release();
});

test("removing the data directory does not drop the write lock", async (t) => {
  const box = sandbox(t);
  const owner = box.own(openJsonlOwner(box.file));
  rmSync(box.dir, { recursive: true, force: true });
  mkdirSync(box.dir);
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.deleteData();
  assert.throws(() => openJsonlOwner(box.file), busy);
  await owner.release();
  const reopened = box.own(openJsonlOwner(box.file));
  await reopened.release();
});

test("a failed inode unlock still releases the path lock", async (t) => {
  const box = sandbox(t);
  const before = new Set(lockDirsHeldBy(process.pid));
  const owner = box.own(openJsonlOwner(box.file));
  const mine = lockDirsHeldBy(process.pid).filter((dir) => !before.has(dir));
  const inodeDir = mine.find((dir) => dir.split(sep).includes("inode"));
  const pathDir = mine.find((dir) => dir.split(sep).includes("path"));
  assert.ok(inodeDir);
  assert.ok(pathDir);
  box.beforeCleanup(() => { if (existsSync(inodeDir)) chmodSync(inodeDir, 0o755); });
  chmodSync(inodeDir, 0o555);
  await assert.rejects(owner.release());
  assert.equal(existsSync(pathDir), false);
  assert.equal(existsSync(inodeDir), true);
  assert.throws(() => openJsonlOwner(box.file), busy);
  chmodSync(inodeDir, 0o755);
  await owner.release();
  assert.equal(existsSync(inodeDir), false);
  const reopened = box.own(openJsonlOwner(box.file));
  await reopened.release();
});

test("delete remains idempotent after a partial unlock and cannot delete a later owner's file", async (t) => {
  const box = sandbox(t);
  const before = new Set(lockDirsHeldBy(process.pid));
  const first = box.own(openJsonlOwner(box.file));
  linkSync(box.file, join(box.dir, "original-inode.jsonl"));
  const inodeDir = lockDirsHeldBy(process.pid).find((dir) => !before.has(dir) && dir.split(sep).includes("inode"));
  assert.ok(inodeDir);
  box.beforeCleanup(() => { if (existsSync(inodeDir)) chmodSync(inodeDir, 0o700); });
  await first.deleteData();
  chmodSync(inodeDir, 0o500);
  await assert.rejects(first.release());
  chmodSync(inodeDir, 0o700);
  const second = box.own(openJsonlOwner(box.file));
  await second.storage.commit([{ type: "set", address: value("box"), value: 2 }]);
  await first.deleteData();
  await first.release();
  assert.equal(await second.storage.read((view) => view.get(value("box"))), 2);
  assert.throws(() => openJsonlOwner(box.file), busy);
  await assert.rejects(first.deleteData(), /storage ownership was released/);
  await second.release();
});

test("an old owner cannot delete the file a later owner holds", async (t) => {
  const box = sandbox(t);
  const first = box.own(openJsonlOwner(box.file));
  await first.storage.commit([{ type: "set", address: value("box"), value: 1 }]);
  await first.release();
  const second = box.own(openJsonlOwner(box.file));
  await second.storage.commit([{ type: "set", address: value("box"), value: 2 }]);
  await assert.rejects(first.deleteData(), /storage ownership was released/);
  assert.equal(await second.storage.read((view) => view.get(value("box"))), 2);
  await first.release();
  assert.throws(() => openJsonlOwner(box.file), busy);
  await second.release();
});

test("unconfirmed lock residue stays busy and does not repair the file", async (t) => {
  const box = sandbox(t);
  writeFileSync(box.file, "{\"writes\":[]}\n{\"torn\"");
  const before = readFileSync(box.file);
  const lockDir = pathLockDirectory(canonicalStoragePath(box.file));
  mkdirSync(lockDir, { recursive: true });
  box.beforeCleanup(() => rmSync(lockDir, { recursive: true, force: true }));
  assert.throws(() => openJsonlOwner(box.file), busy);
  assert.deepEqual(readFileSync(box.file), before);
  writeFileSync(join(lockDir, "owner"), "not-json");
  assert.throws(() => openJsonlOwner(box.file), busy);
  assert.deepEqual(readFileSync(box.file), before);
  writeFileSync(join(lockDir, "owner"), JSON.stringify({ token: "x", pid: 1, hostname: "other-host" }));
  assert.throws(() => openJsonlOwner(box.file), busy);
  assert.deepEqual(readFileSync(box.file), before);
  rmSync(lockDir, { recursive: true, force: true });
  const owner = box.own(openJsonlOwner(box.file));
  assert.equal(readFileSync(box.file, "utf8"), "{\"writes\":[]}\n");
  await owner.release();
});

test("the raw constructor still replays a file without taking the managed lock", async (t) => {
  const box = sandbox(t);
  const raw = new JsonlStorage(box.file);
  await raw.commit([{ type: "set", address: value("box"), value: 3 }]);
  const owner = box.own(openJsonlOwner(box.file));
  assert.equal(await owner.storage.read((view) => view.get(value("box"))), 3);
  await owner.release();
  assert.equal(await new JsonlStorage(box.file).read((view) => view.version()), 1);
});
