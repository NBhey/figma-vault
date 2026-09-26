import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FigmaClient } from "./client.js";
import { pullFigmaSelections } from "./pull.js";
import type { FigmaNodeEntry } from "./types.js";

const imageUrl = "data:application/octet-stream;base64,aW1hZ2U=";
const link = (id: string) => `https://figma.com/design/file-key/Example?node-id=${id.replace(":", "-")}`;

function entry(id: string): FigmaNodeEntry {
  return {
    document: {
      id,
      name: `Screen ${id}`,
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [{
        id: `${id}-photo`,
        name: "Photo",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
        fills: [{ type: "IMAGE", imageRef: "photo" }],
      }],
    },
  };
}

test("batch pull reads and renders two unique screens once, then writes separate raw entries", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-batch-"));
  const nodesCalls: string[] = [];
  const imagesCalls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const ids = url.searchParams.get("ids")!.split(",");
    if (url.pathname.includes("/files/")) {
      nodesCalls.push(ids.join(","));
      return Response.json({ name: "File", nodes: Object.fromEntries(ids.map((id) => [id, entry(id)])) });
    }
    imagesCalls.push(ids.join(","));
    return Response.json({ images: Object.fromEntries(ids.map((id) => [id, imageUrl])) });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");

  try {
    const outcomes = await pullFigmaSelections([link("1:2"), link("1:3"), link("1:2")], {
      token: "secret", vaultDir, client,
    });
    assert.equal(outcomes.length, 2);
    assert.deepEqual(nodesCalls, ["1:2,1:3"]);
    assert.deepEqual(imagesCalls, ["1:2,1:3,1:2-photo,1:3-photo"]);
    for (const outcome of outcomes) {
      assert.ok(outcome.result);
      const raw = JSON.parse(await readFile(path.join(outcome.result.directory, "raw.json"), "utf8"));
      assert.deepEqual(Object.keys(raw.nodes), [outcome.nodeId]);
      assert.equal(await readFile(path.join(outcome.result.directory, "screenshot.png"), "utf8"), "image");
      assert.equal(outcome.result.assetCount, 1);
      assert.equal(await readFile(path.join(outcome.result.directory, `assets/${outcome.nodeId!.replace(":", "_")}_photo.png`), "utf8"), "image");
    }
    const index = JSON.parse(await readFile(path.join(vaultDir, "index.json"), "utf8"));
    assert.equal(index.docs.length, 2);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("batch pull isolates a bad id when the combined nodes request fails", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-batch-"));
  const nodesCalls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/images/")) throw new Error("No images expected");
    const ids = url.searchParams.get("ids")!.split(",");
    nodesCalls.push(ids.join(","));
    if (ids.includes("1:9")) return new Response("invalid id", { status: 400 });
    return Response.json({ name: "File", nodes: Object.fromEntries(ids.map((id) => [id, entry(id)])) });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");

  try {
    const outcomes = await pullFigmaSelections([link("1:2"), link("1:9")], {
      token: "secret", vaultDir, client, noAssets: true,
    });
    assert.deepEqual(nodesCalls, ["1:2,1:9", "1:2", "1:9"]);
    assert.ok(outcomes[0]?.result);
    assert.equal(outcomes[0].result.assetCount, 0);
    assert.ok(outcomes[1]?.error);
    assert.equal((outcomes[1].error as { status?: number }).status, 400);
    const index = JSON.parse(await readFile(path.join(vaultDir, "index.json"), "utf8"));
    assert.equal(index.docs.length, 1);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("batch pull treats a null node as an error only for that screen", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-batch-"));
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({ name: "File", nodes: { "1:2": entry("1:2"), "1:9": null } });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");

  try {
    const outcomes = await pullFigmaSelections([link("1:2"), link("1:9")], {
      token: "secret", vaultDir, client, noAssets: true,
    });
    assert.equal(calls, 1);
    assert.ok(outcomes[0]?.result);
    assert.ok(outcomes[1]?.error);
    assert.equal((outcomes[1].error as { status?: number }).status, 404);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("batch pull keeps the screenshot separate when a screen has 40 raster assets", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-batch-"));
  const imageCalls: string[][] = [];
  const root = entry("1:2");
  root.document.children = Array.from({ length: 40 }, (_, index) => ({
    id: `1:${index + 100}`,
    name: `Photo ${index}`,
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
    fills: [{ type: "IMAGE", imageRef: `photo-${index}` }],
  }));
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/files/")) return Response.json({ name: "File", nodes: { "1:2": root } });
    const ids = url.searchParams.get("ids")!.split(",");
    imageCalls.push(ids);
    return Response.json({ images: Object.fromEntries(ids.map((id) => [id, imageUrl])) });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");

  try {
    const outcomes = await pullFigmaSelections([link("1:2")], { token: "secret", vaultDir, client });
    assert.ok(outcomes[0]?.result);
    assert.equal(imageCalls.length, 2);
    assert.deepEqual(imageCalls[0], ["1:2"]);
    assert.equal(imageCalls[1]?.length, 40);
    assert.equal(outcomes[0].result.assetCount, 40);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("batch pull groups by file and keeps invalid links in input order", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-batch-"));
  const nodesCalls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/images/")) throw new Error("No images expected");
    const fileKey = url.pathname.split("/")[3]!;
    const ids = url.searchParams.get("ids")!.split(",");
    nodesCalls.push(`${fileKey}:${ids.join(",")}`);
    return Response.json({ name: fileKey, nodes: Object.fromEntries(ids.map((id) => [id, entry(id)])) });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");

  try {
    const outcomes = await pullFigmaSelections([
      link("1:2"), "https://example.com/invalid", link("1:3"),
      "https://figma.com/design/other-file/Example?node-id=1-4",
    ], { token: "secret", vaultDir, client, noAssets: true });
    assert.deepEqual(nodesCalls, ["file-key:1:2,1:3", "other-file:1:4"]);
    assert.deepEqual(outcomes.map((outcome) => Boolean(outcome.result)), [true, false, true, true]);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});
