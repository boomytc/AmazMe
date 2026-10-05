import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

function emit(ok, text) {
  const payload = JSON.stringify({ ok, text });
  const exit = () => process.exit(ok ? 0 : 1);
  if (process.stdout.write(payload)) exit();
  else process.stdout.once("drain", exit);
}

function inside(root, target) {
  const full = resolve(root, target);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return full;
}

function denied(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  // Seatbelt denies an existing path with EPERM. Only Linux treats ENOENT as a
  // denial: bubblewrap does not mount the path, so the read misses it.
  if (process.platform === "linux") return code === "EPERM" || code === "EACCES" || code === "ENOENT";
  return code === "EPERM";
}

function probe() {
  const canary = process.argv[3];
  const runtimeFile = process.argv[4];
  const home = process.env.HOME;
  if (!home || !canary || !runtimeFile) {
    process.stderr.write("probe arguments missing\n");
    process.exit(2);
  }
  const probeFile = `${home}/probe-ok`;
  try {
    writeFileSync(probeFile, "ok");
    if (readFileSync(probeFile, "utf8") !== "ok") {
      process.stderr.write("scratch mismatch\n");
      process.exit(2);
    }
    unlinkSync(probeFile);
  } catch (error) {
    process.stderr.write(`scratch ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  for (const target of [canary, runtimeFile]) {
    try {
      readFileSync(target);
      process.stderr.write("forbidden file was readable\n");
      process.exit(2);
    } catch (error) {
      if (!denied(error)) {
        process.stderr.write(`expected denial ${error && error.code}\n`);
        process.exit(2);
      }
    }
  }
  const socket = connect({ host: "127.0.0.1", port: 9 });
  const timer = setTimeout(() => {
    process.stderr.write("network timeout\n");
    process.exit(2);
  }, 2_000);
  socket.on("connect", () => {
    clearTimeout(timer);
    process.stderr.write("network open\n");
    process.exit(2);
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    if (error.code !== "EPERM") {
      process.stderr.write(`network ${error.code}\n`);
      process.exit(2);
    }
    process.stdout.write("PROBE_OK");
    process.exit(0);
  });
}

function readStdin() {
  return new Promise((resolveIn, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolveIn({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolveIn(parsed && typeof parsed === "object" ? parsed : {});
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on("error", reject);
  });
}

function walk(root) {
  const files = [];
  const visit = (dir) => {
    if (files.length > 2000) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".amazme" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function glob(pattern) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${body}$`);
}

function search(workspace, full, op, body) {
  const stat = statSync(full);
  if (op === "ls") {
    if (!stat.isDirectory()) return basename(full);
    return readdirSync(full, { withFileTypes: true })
      .filter((entry) => entry.name !== ".amazme")
      .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
      .sort()
      .join("\n");
  }
  const pattern = typeof body.pattern === "string" ? body.pattern : "";
  if (pattern.length === 0) throw new Error("pattern is required");
  const files = stat.isDirectory() ? walk(full) : [full];
  if (op === "find") {
    const match = glob(pattern);
    return files
      .map((file) => relative(workspace, file))
      .filter((file) => match.test(file) || match.test(basename(file)))
      .sort()
      .join("\n");
  }
  const lines = [];
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(workspace, file);
    text.split("\n").forEach((line, index) => {
      if (line.includes(pattern)) lines.push(`${rel}:${index + 1}:${line}`);
    });
  }
  return lines.join("\n");
}

function operate(workspace, body) {
  const requested = typeof body.path === "string" ? body.path : "";
  const full = inside(workspace, requested);
  if (!full) {
    emit(false, `path escapes the workspace: ${requested}`);
    return;
  }
  const op = process.argv[2];
  try {
    if (op === "read") {
      emit(true, readFileSync(full, "utf8"));
      return;
    }
    if (op === "write") {
      if (typeof body.content !== "string") {
        emit(false, "content must be a string");
        return;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body.content);
      emit(true, "ok");
      return;
    }
    if (op === "edit") {
      if (typeof body.old !== "string" || typeof body.replacement !== "string") {
        emit(false, "edit requires old and replacement");
        return;
      }
      const text = readFileSync(full, "utf8");
      const count = text.split(body.old).length - 1;
      if (count !== 1) {
        emit(false, `expected 1 match, found ${count}`);
        return;
      }
      writeFileSync(full, text.replace(body.old, body.replacement));
      emit(true, "ok");
      return;
    }
    if (op === "grep" || op === "find" || op === "ls") {
      emit(true, search(workspace, full, op, body));
      return;
    }
  } catch (error) {
    emit(false, error instanceof Error ? error.message : String(error));
    return;
  }
  emit(false, `unknown file operation ${op}`);
}

if (process.argv[2] === "probe") probe();
else {
  const workspace = process.argv[3];
  if (!workspace) {
    emit(false, "workspace is required");
  } else {
    readStdin().then((body) => operate(workspace, body), (error) => emit(false, error instanceof Error ? error.message : String(error)));
  }
}
