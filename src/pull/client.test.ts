import assert from "node:assert/strict";
import test from "node:test";

import { FigmaApiError, FigmaClient } from "./client.js";

test("FigmaClient authenticates and requests a selected node with vector geometry", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      name: "File",
      nodes: { "1:2": { document: { id: "1:2", name: "Root", type: "FRAME" } } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");
  const result = await client.getNode("file-key", "1:2");

  assert.equal(result.name, "File");
  assert.match(calls[0]!.url, /\/files\/file-key\/nodes\?/);
  assert.match(calls[0]!.url, /geometry=paths/);
  assert.equal(new Headers(calls[0]!.init?.headers).get("X-Figma-Token"), "secret");
});

test("FigmaClient reports status without leaking its token", async () => {
  const fetcher: typeof fetch = async () => new Response("denied", { status: 403, statusText: "Forbidden" });
  const client = new FigmaClient("do-not-leak", fetcher, "https://figma.test/v1");
  await assert.rejects(
    client.getNode("file-key", "1:2"),
    (error: unknown) => error instanceof FigmaApiError && error.status === 403 && !error.message.includes("do-not-leak"),
  );
});

test("FigmaClient skips the images endpoint when there are no render targets", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1");
  assert.deepEqual(await client.renderNodes("file-key", [], "svg"), {});
  assert.equal(calls, 0);
});
