import assert from "node:assert/strict";
import test from "node:test";

import { canGenerateSvgAsset, collectGeneratedSvgArtifacts } from "./geometry.js";
import { collectRenderTargets, normalizeFigmaResponse } from "./normalize.js";
import type { FigmaNode } from "./types.js";

const root: FigmaNode = {
  id: "1:1",
  name: "Screen",
  type: "FRAME",
  absoluteBoundingBox: { x: 100, y: 200, width: 200, height: 100 },
  children: [
    {
      id: "1:2",
      name: "Icon",
      type: "GROUP",
      absoluteBoundingBox: { x: 110, y: 210, width: 24, height: 24 },
      children: [
        {
          id: "1:3",
          name: "Body",
          type: "VECTOR",
          absoluteBoundingBox: { x: 110, y: 210, width: 24, height: 24 },
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
          fillGeometry: [{ path: "M0 0L24 0L24 24L0 24Z", windingRule: "EVENODD" }],
        },
        {
          id: "1:4",
          name: "Stroke",
          type: "LINE",
          absoluteBoundingBox: { x: 109, y: 209, width: 26, height: 0 },
          strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 0.5 }],
          strokeGeometry: [{ path: "M-1 -1L25 -1L25 1L-1 1Z" }],
        },
      ],
    },
    {
      id: "1:5",
      name: "Remote fallback",
      type: "VECTOR",
      absoluteBoundingBox: { x: 150, y: 210, width: 24, height: 24 },
    },
    {
      id: "1:6",
      name: "Hidden slot",
      type: "FRAME",
      visible: false,
      absoluteBoundingBox: { x: 180, y: 210, width: 24, height: 24 },
      children: [{
        id: "1:7",
        name: "Hidden raster",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 180, y: 210, width: 24, height: 24 },
        fills: [{ type: "IMAGE", imageRef: "hidden" }],
      }],
    },
  ],
};

test("builds complete icon SVGs from local Figma geometry", () => {
  assert.equal(canGenerateSvgAsset(root.children![0]!), true);
  const artifacts = collectGeneratedSvgArtifacts(root);
  const group = artifacts.find((item) => item.relativePath === "assets/1_2.svg");
  assert.ok(group);
  assert.equal(typeof group.content, "string");
  assert.match(String(group.content), /fill-rule="evenodd"/);
  assert.match(String(group.content), /fill="#ff0000"/);
  assert.match(String(group.content), /fill="#0000ff80"/);
  assert.match(String(group.content), /translate\(-1 -1\)/);
  assert.match(String(group.content), /viewBox="-2 -2 26 26"/);

  const document = normalizeFigmaResponse({
    name: "Geometry",
    nodes: { "1:1": { document: root } },
  }, "file", "1:1");
  assert.equal(document.root.children[0]?.asset?.path, "assets/1_2.svg");
});

test("renders remotely only vector nodes that have no local geometry", () => {
  assert.deepEqual(collectRenderTargets(root), { png: [], svg: ["1:5"] });
});
