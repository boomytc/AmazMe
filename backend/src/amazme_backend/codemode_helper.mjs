import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { QuickJS } from "quickjs-wasi";

const require = createRequire(import.meta.url);
const wasm = await readFile(require.resolve("quickjs-wasi/quickjs.wasm"));
const input = [];
let carry = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  carry += chunk;
  let nl;
  while ((nl = carry.indexOf("\n")) >= 0) {
    input.push(carry.slice(0, nl));
    carry = carry.slice(nl + 1);
  }
});

function take() {
  return input.length ? JSON.parse(input.shift()) : null;
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const permit = await new Promise(resolve => {
  const timer = setInterval(() => {
    const line = take();
    if (line) { clearInterval(timer); resolve(line); }
  }, 5);
});

const MAX_IN_FLIGHT = 2;
const OUTPUT_LIMIT = 8192;
const STATE_VALUE = 4096;
const STATE_TOTAL = 16384;
const deadline = Date.now() + permit.timeout_ms;
let cancelled = false;
let output = "";
const draft = { ...(permit.state || {}) };
const inFlight = new Map();
let seq = 0;

const vm = await QuickJS.create({
  wasm,
  memoryLimit: permit.memory_limit,
  interruptHandler: () => cancelled || Date.now() > deadline,
});

function hostCall(nameHandle, argsHandle) {
  const name = vm.dump(nameHandle);
  const args = vm.dump(argsHandle);
  const deferred = vm.newPromise();
  if (inFlight.size >= MAX_IN_FLIGHT) {
    const error = vm.newString("too many tool calls");
    deferred.reject(error);
    error.dispose();
    return deferred.handle;
  }
  const id = String(++seq);
  inFlight.set(id, deferred);
  send({ op: "tool", id, name, arguments: args });
  return deferred.handle;
}

const callFn = vm.newFunction("call", hostCall);
const getFn = vm.newFunction("get", keyHandle => {
  const key = vm.dump(keyHandle);
  if (!Object.prototype.hasOwnProperty.call(draft, key)) return vm.undefined;
  return vm.newString(JSON.stringify(draft[key]));
});
const setFn = vm.newFunction("set", (keyHandle, valueHandle) => {
  const key = vm.dump(keyHandle);
  const value = vm.dump(valueHandle);
  const encoded = JSON.stringify(value);
  if (typeof key !== "string" || !key || key.length > 64 || encoded.length > STATE_VALUE) {
    throw new Error("state rejected");
  }
  const next = { ...draft, [key]: value };
  if (JSON.stringify(next).length > STATE_TOTAL) throw new Error("state rejected");
  draft[key] = value;
  return vm.undefined;
});
const logFn = vm.newFunction("log", valueHandle => {
  const text = String(vm.dump(valueHandle));
  if (output.length < OUTPUT_LIMIT) output += text.slice(0, OUTPUT_LIMIT - output.length) + "\n";
  return vm.undefined;
});
vm.setProp(vm.global, "__call", callFn);
vm.setProp(vm.global, "__get", getFn);
vm.setProp(vm.global, "__set", setFn);
vm.setProp(vm.global, "__log", logFn);

const wrapped = `(async () => {
  const bridge = {
    call: async (name, args) => JSON.parse(await __call(name, args)),
    state: { get: key => { const raw = __get(key); return raw === undefined ? undefined : JSON.parse(raw); }, set: (key, value) => __set(key, value) },
    log: value => __log(value),
  };
  const value = await (async () => { ${permit.source} })();
  return JSON.stringify(value === undefined ? null : value);
})()`;

let failure = "";
try {
  const handle = vm.evalCode(wrapped, "script.js");
  const pending = vm.resolvePromise(handle);
  let settled = null;
  pending.then(value => {
    settled = value;
  });
  const stop = Date.now() + permit.timeout_ms + 200;
  while (!settled && Date.now() < stop) {
    vm.executePendingJobs();
    const message = take();
    if (message?.op === "cancel") cancelled = true;
    if (message?.op === "tool_result" && inFlight.has(message.id)) {
      const deferred = inFlight.get(message.id);
      inFlight.delete(message.id);
      if (message.error) {
        const error = vm.newString(String(message.error));
        deferred.reject(error);
        error.dispose();
      } else {
        const value = vm.newString(JSON.stringify(message.result ?? null));
        deferred.resolve(value);
        value.dispose();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!settled) failure = cancelled ? "cancelled" : "timeout";
  else if (settled.error) failure = settled.error.toString();
  else {
    const raw = vm.dump(settled.value);
    send({ op: "success", value: typeof raw === "string" ? JSON.parse(raw) : raw, state: draft, output });
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
if (failure) send({ op: "failure", message: failure, output });
vm.dispose();
process.exit(failure ? 1 : 0);
