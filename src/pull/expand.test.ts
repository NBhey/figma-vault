import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FigmaClient } from "./client.js";
import { ScreensSkippedError } from "./expand.js";
import { pullFigmaSelections } from "./pull.js";
import type { FigmaNode } from "./types.js";

const link = (id: string) => `https://figma.com/design/file-key/Example?node-id=${id.replace(":", "-")}`;

function node(id: string, type: string, y: number, extra: Partial<FigmaNode> = {}): FigmaNode {
  return { id, name: `${type} ${id}`, type, absoluteBoundingBox: { x: 0, y, width: 100, height: 100 }, ...extra };
}

/** Страница 0:1: два экрана вразнобой, скрытый, текст и секция 1:10 с вложенной 1:20. */
const tree: Record<string, FigmaNode> = {
  "0:1": node("0:1", "CANVAS", 0, {
    children: [
      node("1:2", "FRAME", 500),
      node("1:3", "FRAME", 0),
      node("1:4", "FRAME", 50, { visible: false }),
      node("1:5", "TEXT", 10),
      node("1:10", "SECTION", 1000),
    ],
  }),
  "1:10": node("1:10", "SECTION", 1000, {
    children: [node("1:11", "COMPONENT", 1000), node("1:20", "SECTION", 1200)],
  }),
  "1:20": node("1:20", "SECTION", 1200, { children: [node("1:21", "INSTANCE", 1200)] }),
  "1:30": node("1:30", "SECTION", 0, { children: [] }),
};
for (const id of ["1:2", "1:3", "1:11", "1:21"]) tree[id] = node(id, "FRAME", 0);

function shallow(item: FigmaNode): FigmaNode {
  return { ...item, children: item.children?.map(({ children: _, ...child }) => child as FigmaNode) };
}

function harness(options: { outlineStatus?: number; badId?: string } = {}) {
  const outlineCalls: string[] = [];
  const fullCalls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/images/")) throw new Error("No renders expected");
    const ids = url.searchParams.get("ids")!.split(",");
    if (url.searchParams.has("depth")) {
      assert.equal(url.searchParams.get("depth"), "1");
      assert.equal(url.searchParams.has("geometry"), false);
      outlineCalls.push(ids.join(","));
      if (options.outlineStatus) return new Response("limited", { status: options.outlineStatus });
      if (options.badId && ids.includes(options.badId)) return new Response("bad id", { status: 400 });
      return Response.json({
        name: "File",
        nodes: Object.fromEntries(ids.map((id) => [id, tree[id] ? { document: shallow(tree[id]!) } : null])),
      });
    }
    fullCalls.push(ids.join(","));
    return Response.json({
      name: "File",
      nodes: Object.fromEntries(ids.map((id) => [id, tree[id] ? { document: tree[id] } : null])),
    });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1", { maxRetries: 0 });
  return { client, outlineCalls, fullCalls };
}

async function withVault(run: (vaultDir: string) => Promise<void>): Promise<void> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-expand-"));
  try {
    await run(vaultDir);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
}

test("expand turns a page into its visible screens in visual order, nested sections included", async () => {
  await withVault(async (vaultDir) => {
    const { client, outlineCalls, fullCalls } = harness();
    const outcomes = await pullFigmaSelections([link("0:1"), link("1:2")], {
      token: "secret", vaultDir, client, noAssets: true, expand: true,
    });
    assert.deepEqual(outlineCalls, ["0:1,1:2", "1:10", "1:20"]);
    assert.deepEqual(fullCalls, ["1:3,1:11,1:21,1:2"]);
    assert.deepEqual(outcomes.map((outcome) => [outcome.nodeId, outcome.expandedFrom, !!outcome.result]), [
      ["1:3", "0:1", true],
      ["1:11", "0:1", true],
      ["1:21", "0:1", true],
      ["1:2", undefined, true],
    ]);
  });
});

test("expand stops at the screen limit and reports the rest", async () => {
  await withVault(async (vaultDir) => {
    const { client, fullCalls } = harness();
    const outcomes = await pullFigmaSelections([link("0:1")], {
      token: "secret", vaultDir, client, noAssets: true, expand: true, maxScreens: 2,
    });
    assert.deepEqual(fullCalls, ["1:3,1:2"]);
    const skipped = outcomes.find((outcome) => outcome.error)?.error;
    assert.ok(skipped instanceof ScreensSkippedError);
    assert.deepEqual(skipped.skipped, ["1:11", "1:21"]);
    assert.match(skipped.message, /limit of 2/);
  });
});

test("expand reports an empty section without calling the full nodes endpoint", async () => {
  await withVault(async (vaultDir) => {
    const { client, fullCalls } = harness();
    const outcomes = await pullFigmaSelections([link("1:30")], {
      token: "secret", vaultDir, client, noAssets: true, expand: true,
    });
    assert.deepEqual(fullCalls, []);
    assert.match(outcomes[0]!.error!.message, /no visible frames/);
  });
});

test("a rate-limited outline fails the file's links instead of fetching a whole page", async () => {
  await withVault(async (vaultDir) => {
    const { client, outlineCalls, fullCalls } = harness({ outlineStatus: 429 });
    const outcomes = await pullFigmaSelections([link("0:1"), link("1:2")], {
      token: "secret", vaultDir, client, noAssets: true, expand: true,
    });
    assert.deepEqual(outlineCalls, ["0:1,1:2"]);
    assert.deepEqual(fullCalls, []);
    assert.equal(outcomes.length, 2);
    for (const outcome of outcomes) assert.match(outcome.error!.message, /429/);
  });
});

test("a bad id in the outline is isolated and the page still expands", async () => {
  await withVault(async (vaultDir) => {
    const { client, outlineCalls, fullCalls } = harness({ badId: "9:9" });
    const outcomes = await pullFigmaSelections([link("0:1"), link("9:9")], {
      token: "secret", vaultDir, client, noAssets: true, expand: true, maxScreens: 1,
    });
    assert.deepEqual(outlineCalls, ["0:1,9:9", "0:1", "9:9", "1:10", "1:20"]);
    assert.equal(fullCalls[0], "1:3,9:9");
    assert.equal(outcomes.find((outcome) => outcome.nodeId === "1:3")?.expandedFrom, "0:1");
    assert.ok(outcomes.find((outcome) => outcome.nodeId === "9:9")?.error);
  });
});

test("without expand a section is exported as one document with a hint and no outline call", async () => {
  await withVault(async (vaultDir) => {
    const { client, outlineCalls, fullCalls } = harness();
    const [outcome] = await pullFigmaSelections([link("1:10")], {
      token: "secret", vaultDir, client, noAssets: true,
    });
    assert.deepEqual(outlineCalls, []);
    assert.deepEqual(fullCalls, ["1:10"]);
    assert.ok(outcome?.result?.warnings.some((warning) => /SECTION.*separate screens/.test(warning)));
  });
});
