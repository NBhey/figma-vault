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

test("FigmaClient waits for Retry-After and retries a 429 response", async () => {
  let calls = 0;
  const waits: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("limited", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "2" },
      });
    }
    return new Response(JSON.stringify({
      name: "File",
      nodes: { "1:2": { document: { id: "1:2", name: "Root", type: "FRAME" } } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1", {
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  const result = await client.getNode("file-key", "1:2");
  assert.equal(result.name, "File");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});

test("FigmaClient stops after bounded retries and exposes rate-limit metadata", async () => {
  let calls = 0;
  const waits: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response("limited", {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "retry-after": "3",
        "x-figma-plan-tier": "pro",
        "x-figma-rate-limit-type": "low",
        "x-figma-upgrade-link": "https://figma.com/pricing",
      },
    });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1", {
    maxRetries: 2,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  await assert.rejects(client.getNode("file-key", "1:2"), (error: unknown) => {
    assert.ok(error instanceof FigmaApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 3);
    assert.equal(error.planTier, "pro");
    assert.equal(error.rateLimitType, "low");
    assert.equal(error.upgradeLink, "https://figma.com/pricing");
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3_000, 3_000]);
});

test("FigmaClient does not sleep for a multi-day Retry-After", async () => {
  let calls = 0;
  const waits: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response("monthly limit", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "399959" },
    });
  };
  const client = new FigmaClient("secret", fetcher, "https://figma.test/v1", {
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  await assert.rejects(
    client.getNode("file-key", "1:2"),
    (error: unknown) => error instanceof FigmaApiError && error.retryAfterSeconds === 399959,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});
