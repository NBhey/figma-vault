import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAdd } from "./add.js";
import { runLimits } from "./limits.js";

const link = (id: string) => `https://figma.com/design/file-key/Example?node-id=${id.replace(":", "-")}`;

test("add --no-assets exports unique screens together and reports a failed screen", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-cli-add-"));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_TOKEN;
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  const calls: string[] = [];
  let output = "";
  process.env.FIGMA_TOKEN = "secret";
  process.exitCode = 0;
  process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.get("ids")}`);
    assert.match(url.pathname, /\/files\//);
    return Response.json({
      name: "File",
      nodes: {
        "1:2": { document: {
          id: "1:2", name: "First", type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: [],
        } },
        "1:3": null,
      },
    });
  };
  try {
    await runAdd([link("1:2"), link("1:3"), link("1:2")], { vaultDir, noAssets: true });
    assert.deepEqual(calls, ["/v1/files/file-key/nodes?1:2,1:3"]);
    assert.match(output, /node-id=1-2[\s\S]*done:/);
    assert.match(output, /node-id=1-3[\s\S]*failed:/);
    assert.match(output, /1 exported, 1 failed/);
    assert.equal(process.exitCode, 1);
    const index = JSON.parse(await readFile(path.join(vaultDir, "index.json"), "utf8"));
    assert.equal(index.docs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalToken === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = originalToken;
    process.exitCode = originalExitCode;
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("limits groups links from one file into one structure and one render probe", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_TOKEN;
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  const calls: string[] = [];
  let output = "";
  process.env.FIGMA_TOKEN = "secret";
  process.exitCode = 0;
  process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.get("ids")}`);
    return Response.json({});
  };
  try {
    await runLimits([link("1:2"), link("1:3"), link("1:2")]);
    assert.deepEqual(calls, [
      "/v1/files/file-key/nodes?1:2,1:3",
      "/v1/images/file-key?1:2,1:3",
    ]);
    assert.match(output, /2 unique screen/);
    assert.match(output, /Asset renders may still need more requests/);
    assert.equal(process.exitCode, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalToken === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = originalToken;
    process.exitCode = originalExitCode;
  }
});

test("add --expand reports skipped screens as a warning without failing", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-cli-expand-"));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_TOKEN;
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let output = "";
  process.env.FIGMA_TOKEN = "secret";
  process.exitCode = 0;
  process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
  const frame = (id: string) => ({
    id, name: `Frame ${id}`, type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: [],
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const ids = url.searchParams.get("ids")!.split(",");
    if (url.searchParams.has("depth")) {
      return Response.json({ name: "File", nodes: {
        "0:1": { document: {
          id: "0:1", name: "Page", type: "CANVAS",
          children: [frame("1:2"), frame("1:3")],
        } },
      } });
    }
    return Response.json({ name: "File", nodes: Object.fromEntries(
      ids.map((id) => [id, { document: frame(id) }]),
    ) });
  };
  try {
    await runAdd([link("0:1")], { vaultDir, noAssets: true, expand: true, maxScreens: 1 });
    assert.match(output, /node-id=0-1 → 1:2[\s\S]*done:/);
    assert.match(output, /warning:[\s\S]*beyond the limit of 1/);
    assert.match(output, /1 exported, 0 failed/);
    assert.equal(process.exitCode, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalToken === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = originalToken;
    process.exitCode = originalExitCode;
    await rm(vaultDir, { recursive: true, force: true });
  }
});
