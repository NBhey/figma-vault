import assert from "node:assert/strict";
import test from "node:test";

import { verifySnapshot, type DomSnapshot } from "./verify.js";
import type { VaultDocument } from "./types.js";

const doc: VaultDocument = {
  schema: "figma-vault/doc@1",
  source: {
    fileKey: "file",
    nodeId: "1:1",
    fileName: "Example",
    nodeName: "Screen",
    exportedAt: "2026-09-23T00:00:00.000Z",
    figmaVersion: "1",
  },
  tokens: { colors: {}, text: {}, effects: {} },
  root: {
    id: "1:1",
    name: "Screen",
    type: "frame",
    layout: { mode: "none", x: 0, y: 0, w: 320, h: 200 },
    children: [
      {
        id: "1:2",
        name: "Card",
        type: "frame",
        layout: { mode: "none", x: 10, y: 20, w: 200, h: 80 },
        children: [
          {
            id: "1:3",
            name: "Title",
            type: "text",
            layout: { mode: "none", x: 5, y: 6, w: 100, h: 24 },
            text: { content: "Hello world" },
            children: [],
          },
        ],
      },
      {
        id: "1:4",
        name: "Hidden variant",
        type: "text",
        hidden: true,
        layout: { mode: "none", x: 0, y: 0, w: 50, h: 20 },
        text: { content: "Do not show" },
        children: [],
      },
    ],
  },
};

const snapshot: DomSnapshot = {
  schema: "figma-vault/snapshot@0",
  root: "1:1",
  viewport: { w: 320, h: 200 },
  texts: ["Hello", "world"],
  nodes: [
    { id: "1:1", x: 0, y: 0, w: 320, h: 200 },
    { id: "1:2", x: 10, y: 20, w: 200, h: 80 },
    { id: "1:3", x: 15, y: 26, w: 100, h: 24 },
  ],
};

test("verifySnapshot checks visible text and nested block geometry", () => {
  const report = verifySnapshot(doc, snapshot);
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.text, { total: 1, matched: 1, missing: [] });
  assert.equal(report.geometry.mappedNodes, 3);
  assert.equal(report.geometry.visibleNodes, 3);
});

test("verifySnapshot reports missing repeated text and out-of-tolerance geometry", () => {
  const repeated = structuredClone(doc);
  repeated.root.children.push({
    id: "1:5",
    name: "Second title",
    type: "text",
    layout: { mode: "none", x: 10, y: 120, w: 100, h: 24 },
    text: { content: "Hello world" },
    children: [],
  });
  const moved = structuredClone(snapshot);
  moved.nodes[1]!.x = 16;
  const report = verifySnapshot(repeated, moved, { tolerancePx: 2 });
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.text.missing.length, 1);
  assert.deepEqual(report.geometry.mismatches.map((item) => item.property), ["x"]);
});

test("verifySnapshot marks a text-only result as incomplete", () => {
  const noMappings = { ...snapshot, root: null, nodes: [] };
  const report = verifySnapshot(doc, noMappings);
  assert.equal(report.verdict, "INCOMPLETE");
  assert.equal(report.text.matched, 1);
  assert.equal(report.geometry.missingRoot, true);
});
