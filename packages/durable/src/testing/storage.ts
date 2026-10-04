import assert from "node:assert/strict";
import { list, value, type Apply, type Storage, type Write } from "../storage.ts";

export interface StorageFixture {
  storage: Storage;
  dispose?: () => void | Promise<void>;
}

export interface StorageConformanceCase {
  name: string;
  run(): Promise<void>;
}

/** Runner-independent cases; each case acquires and disposes a fresh, empty backend. */
export function createStorageConformance(factory: () => StorageFixture | Promise<StorageFixture>): StorageConformanceCase[] {
  const cases: Array<{ name: string; run(storage: Storage): Promise<void> }> = [
    {
      name: "one apply publishes the complete entry, value, list and usage batch",
      async run(storage) {
        let publications = 0;
        const unsubscribe = storage.subscribe(() => { publications += 1; });
        await storage.run((view, apply) => {
          const result = apply([
            { type: "entry", id: "entry", parentId: null, timestamp: 1, payload: { type: "compaction", summary: "summary" } },
            { type: "usage", id: "usage", operationId: "operation", input: 2, output: 3, totalTokens: 5 },
            { type: "set", address: value("test.tip"), value: "entry" },
            { type: "append", address: list("test.frames"), item: "frame" },
          ]);
          assert.equal(result.seq, 4);
          assert.equal(view.entry("entry")?.seq, 1);
          assert.equal(view.get(value("test.tip")), "entry");
          assert.deepEqual(view.usageRows(), [{ id: "usage", operationId: "operation", seq: 2, input: 2, output: 3, totalTokens: 5 }]);
          assert.deepEqual(view.items(list("test.frames")), [{ seq: 4, item: "frame" }]);
        });
        assert.equal(publications, 1);
        unsubscribe();
        await storage.commit([{ type: "set", address: value("test.after"), value: true }]);
        assert.equal(publications, 1);
        assert.equal(await storage.read((view) => view.entries().length), 1);
      },
    },
    {
      name: "a rejected batch changes neither state nor publication sequence",
      async run(storage) {
        const entry = { type: "entry", id: "entry", parentId: null, timestamp: 1, payload: { type: "compaction", summary: "summary" } } as const;
        await storage.commit([entry]);
        let publications = 0;
        storage.subscribe(() => { publications += 1; });
        await assert.rejects(storage.commit([{ type: "set", address: value("test.partial"), value: true }, entry]), /duplicate entry/);
        await assert.rejects(storage.commit([{ ...entry, id: "orphan", parentId: "missing" }]), /missing parent/);
        assert.equal(await storage.read((view) => view.get(value("test.partial"))), undefined);
        assert.equal(await storage.read((view) => view.entries().length), 1);
        assert.equal(publications, 0);
        assert.equal((await storage.commit([{ type: "set", address: value("test.next"), value: true }])).seq, 2);
      },
    },
    {
      name: "value and list replacement and deletion preserve immutable entries",
      async run(storage) {
        await storage.commit([
          { type: "entry", id: "entry", parentId: null, timestamp: 1, payload: { type: "compaction", summary: "summary" } },
          { type: "set", address: value("test.value"), value: 1 },
          { type: "append", address: list("test.list"), item: 1 },
        ]);
        await storage.commit([{ type: "set", address: value("test.value"), value: 2 }, { type: "append", address: list("test.list"), item: 2 }]);
        assert.equal(await storage.read((view) => view.get(value("test.value"))), 2);
        assert.deepEqual(await storage.read((view) => view.items(list("test.list")).map((item) => item.item)), [1, 2]);
        await storage.commit([{ type: "delete", address: value("test.value") }, { type: "deleteList", address: list("test.list") }]);
        await storage.read((view) => {
          assert.deepEqual(view.values(), []);
          assert.deepEqual(view.lists(), []);
          assert.equal(view.entry("entry")?.payload.type, "compaction");
        });
      },
    },
    {
      name: "reads and commits wait for an asynchronous run to release the mutation line",
      async run(storage) {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered: () => void = () => {};
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const first = storage.run(async (_view, apply) => {
          entered();
          await gate;
          apply([{ type: "set", address: value("test.order"), value: 1 }]);
        });
        await started;
        let observed = false;
        const read = storage.read((view) => { observed = true; return view.get(value("test.order")); });
        const last = storage.commit([{ type: "set", address: value("test.order"), value: 2 }]);
        const idle = storage.whenIdle();
        await Promise.resolve();
        assert.equal(observed, false);
        release();
        await first;
        assert.equal(await read, 1);
        await last;
        await idle;
        assert.equal(await storage.read((view) => view.get(value("test.order"))), 2);
      },
    },
    {
      name: "run failure preserves earlier applies and does not poison later runs",
      async run(storage) {
        const failure = new Error("after commit");
        await assert.rejects(storage.run((_view, apply) => {
          apply([{ type: "set", address: value("test.kept"), value: true }]);
          throw failure;
        }), (error) => error === failure);
        assert.equal(await storage.read((view) => view.get(value("test.kept"))), true);
        assert.equal((await storage.commit([{ type: "set", address: value("test.next"), value: true }])).seq, 2);
      },
    },
    {
      name: "apply expires after either callback completion or rejection",
      async run(storage) {
        for (const fail of [false, true]) {
          let escaped: Apply = () => { throw new Error("not entered"); };
          const run = storage.run((_view, apply) => {
            escaped = apply;
            if (fail) throw new Error("callback failed");
          });
          if (fail) await assert.rejects(run, /callback failed/);
          else await run;
          assert.throws(() => escaped([{ type: "set", address: value("test.escaped"), value: true }]), /outside storage.run/);
        }
        let late: Promise<void> = Promise.resolve();
        await storage.run((_view, apply) => {
          late = new Promise((resolve, reject) => {
            queueMicrotask(() => {
              try {
                assert.throws(() => apply([{ type: "set", address: value("test.escaped"), value: true }]), /outside storage.run/);
                resolve();
              } catch (error) { reject(error); }
            });
          });
        });
        await late;
        assert.equal(await storage.read((view) => view.get(value("test.escaped"))), undefined);
      },
    },
    {
      name: "version advances with every write type, matches the commit seq and ignores reads and rejected batches",
      async run(storage) {
        assert.equal(await storage.read((view) => view.version()), 0);
        const writes: Write[] = [
          { type: "entry", id: "entry", parentId: null, timestamp: 1, payload: { type: "compaction", summary: "summary" } },
          { type: "usage", id: "usage", operationId: "operation", input: 1, output: 1, totalTokens: 2 },
          { type: "set", address: value("test.value"), value: 1 },
          { type: "delete", address: value("test.value") },
          { type: "append", address: list("test.list"), item: 1 },
          { type: "deleteList", address: list("test.list") },
        ];
        let previous = 0;
        for (const write of writes) {
          const committed = await storage.commit([write]);
          const version = await storage.read((view) => view.version());
          assert.equal(version, committed.seq, write.type);
          assert.ok(version > previous, write.type);
          previous = version;
        }
        await assert.rejects(storage.commit([{ type: "set", address: value("test.partial"), value: true }, writes[0]!]), /duplicate entry/);
        await storage.read(() => undefined);
        assert.equal(await storage.read((view) => view.version()), previous);
        await storage.run((view, apply) => {
          assert.equal(view.version(), previous);
          const result = apply([{ type: "set", address: value("test.inside"), value: true }]);
          assert.equal(view.version(), result.seq);
          assert.ok(result.seq > previous);
        });
      },
    },
    {
      name: "invalid addresses reject the whole batch",
      async run(storage) {
        for (const address of [value(""), value("test\0bad"), value("test", "bad\0key")]) {
          await assert.rejects(storage.commit([
            { type: "set", address: value("test.partial"), value: true },
            { type: "set", address, value: true },
          ]));
        }
        assert.equal(await storage.read((view) => view.values().length), 0);
      },
    },
  ];
  return cases.map((case_) => ({
    name: case_.name,
    async run() {
      const fixture = await factory();
      try { await case_.run(fixture.storage); }
      finally { await fixture.dispose?.(); }
    },
  }));
}
