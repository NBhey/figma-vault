import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FigmaClient } from "./client.js";
import { pullFigmaSelection } from "./pull.js";
import type { FigmaNodesResponse } from "./types.js";

const response: FigmaNodesResponse = {
  name: "Partial export",
  version: "1",
  nodes: {
    "1:2": {
      document: {
        id: "1:2",
        name: "Screen",
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        children: [
          {
            id: "1:3",
            name: "Local icon",
            type: "VECTOR",
            absoluteBoundingBox: { x: 8, y: 8, width: 24, height: 24 },
            fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
            fillGeometry: [{ path: "M0 0L24 0L24 24L0 24Z" }],
          },
          {
            id: "1:4",
            name: "Photo",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 40, y: 8, width: 40, height: 40 },
            fills: [{ type: "IMAGE", imageRef: "photo" }],
          },
        ],
      },
    },
  },
};

test("pull keeps structure and local SVGs when optional Figma renders stay rate-limited", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-pull-"));
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/files/")) {
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("limited", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "399959" },
    });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");

  try {
    const result = await pullFigmaSelection(
      "https://figma.com/design/file-key/Example?node-id=1-2",
      { token: "secret", vaultDir, client },
    );

    assert.equal(result.nodeCount, 3);
    assert.equal(result.assetCount, 1);
    assert.equal(calls.filter((url) => url.includes("/images/")).length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes("Скриншот недоступен")));
    assert.ok(result.warnings.some((warning) => warning.includes("Растровые ассеты недоступен")));
    assert.match(
      await readFile(path.join(result.directory, "assets/1_3.svg"), "utf8"),
      /<svg/,
    );
    await assert.rejects(access(path.join(result.directory, "assets/1_4.png")));
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});
