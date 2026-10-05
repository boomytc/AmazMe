import assert from "node:assert/strict";
import test from "node:test";
import { world } from "./support.ts";

test("files forwards the host list, drops paths outside the workspace, and keeps at most 200", async () => {
  const seen: string[] = [];
  const env = world({
    listFiles: (query) => {
      seen.push(query);
      return Promise.resolve([
        "src/a.ts",
        "notes.md",
        "../secret",
        "/tmp/outside",
        "C:\\windows",
        ...Array.from({ length: 210 }, (_, index) => `f${index}.txt`),
      ]);
    },
  });
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    const paths = await remote.lane("main").files("src");
    assert.deepEqual(seen, ["src"]);
    assert.equal(paths[0], "src/a.ts");
    assert.equal(paths[1], "notes.md");
    assert.equal(paths.some((path) => path.startsWith("..") || path.startsWith("/") || path.includes(":")), false);
    assert.equal(paths.length, 200);
  } finally {
    await env.close();
  }
});

test("files is empty when the host does not list a workspace", async () => {
  const env = world();
  try {
    const { remote } = await env.connect();
    await remote.attach("main");
    assert.deepEqual(await remote.lane("main").files(""), []);
  } finally {
    await env.close();
  }
});
