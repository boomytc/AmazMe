// The existing Pi-derived QuickJS engine supplies the script environment; Python owns tool execution.
import { createInterface } from "node:readline";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@amazme/codemode";

const lines = createInterface({input:process.stdin, crlfDelay:Infinity});
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done || Buffer.byteLength(first.value) > 1024 * 1024) process.exit(2);
const permit = JSON.parse(first.value);
const pending = new Map();
const cancelled = new AbortController();
let nextId = 0;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const tool = item => ({name:item.name, description:item.description, execute(args, context) {
  if (pending.size >= 2) throw Error("too many tool calls");
  const id = String(++nextId);
  return new Promise((resolve, reject) => {
    const onAbort = () => {pending.delete(id); reject(Error("cancelled"));};
    context.signal.addEventListener("abort", onAbort, {once:true});
    pending.set(id, {resolve, reject, dispose:()=>context.signal.removeEventListener("abort", onAbort)});
    send({op:"tool",id,name:item.name,arguments:args});
  });
}});
const sandbox = new InlineCodemodeSandbox({wasm:loadQuickJSWasm(), memoryLimitBytes:permit.memory_limit,
  timeoutMs:permit.timeout_ms, tools:(permit.tools || []).map(tool)});
const reading = (async () => {
  for await (const raw of {[Symbol.asyncIterator]:()=>iterator}) {
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error("ipc limit");
    const message = JSON.parse(raw);
    if (message.op === "cancel") {cancelled.abort(); continue;}
    if (message.op !== "tool_result" || !pending.has(message.id)) throw Error("unexpected tool receipt");
    const call = pending.get(message.id);
    pending.delete(message.id); call.dispose();
    if (message.error) call.reject(Error(message.error));
    else call.resolve(message.result);
  }
  cancelled.abort();
})().catch(error => cancelled.abort(error));
try {
  const result = await sandbox.execute(permit.source, {store:permit.state || {}, signal:cancelled.signal});
  const output = result.output.filter(item=>item.type === "text").map(item=>item.text).join("\n");
  if (result.ok) {
    const state = {...(permit.state || {}), ...result.storeWrites.set};
    for (const key of result.storeWrites.delete) delete state[key];
    send({op:"success",value:result.value ?? null,state,output,items:result.output,calls:result.calls});
  } else send({op:"failure",message:result.error.message,kind:result.error.kind,output,items:result.output,calls:result.calls});
} catch (error) {
  send({op:"failure",message:error instanceof Error ? error.message : String(error),kind:"sandbox"});
} finally {
  await sandbox.close();
  lines.close();
}
void reading;
process.exit(0);
