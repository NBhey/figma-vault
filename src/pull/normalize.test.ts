import assert from "node:assert/strict";
import test from "node:test";

import { collectRenderTargets, countVaultNodes, normalizeFigmaResponse } from "./normalize.js";
import { makeDocId, parseFigmaUrl } from "./url.js";
import type { FigmaNodesResponse } from "./types.js";

const response: FigmaNodesResponse = {
  name: "Checkout",
  version: "42",
  nodes: {
    "1:2": {
      styles: {
        fillStyle: { name: "brand/500" },
        textStyle: { name: "label/md" },
      },
      components: {
        "7:7": { name: "Button/Primary" },
      },
      document: {
        id: "1:2",
        name: "Checkout / Mobile",
        type: "FRAME",
        layoutMode: "VERTICAL",
        itemSpacing: 8,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        absoluteBoundingBox: { x: 100, y: 200, width: 320, height: 640 },
        fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
        children: [
          {
            id: "2:3",
            name: "Title",
            type: "TEXT",
            characters: "Оплата",
            absoluteBoundingBox: { x: 116, y: 216, width: 120, height: 32 },
            fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
            styles: { text: "textStyle" },
            style: {
              fontFamily: "Inter",
              fontSize: 24,
              fontWeight: 600,
              lineHeightPx: 32,
              letterSpacing: 0,
              textAlignHorizontal: "LEFT",
            },
          },
          {
            id: "2:4",
            name: "Hero",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 116, y: 264, width: 288, height: 160 },
            fills: [{ type: "IMAGE", imageRef: "hash" }],
          },
          {
            id: "2:5",
            name: "Arrow",
            type: "VECTOR",
            absoluteBoundingBox: { x: 380, y: 440, width: 24, height: 24 },
          },
          {
            id: "2:6",
            name: "Hidden",
            type: "TEXT",
            visible: false,
            characters: "ignore",
            absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      },
    },
  },
};

test("parseFigmaUrl extracts file and normalizes node id", () => {
  assert.deepEqual(
    parseFigmaUrl("https://www.figma.com/design/abc123/Checkout?node-id=1-2&t=ignored"),
    { fileKey: "abc123", nodeId: "1:2" },
  );
  assert.equal(makeDocId("abc123", "1:2"), "abc123_1_2");
});

test("parseFigmaUrl rejects non-Figma and missing selections", () => {
  assert.throws(() => parseFigmaUrl("https://example.com/design/abc/Test?node-id=1-2"), /figma\.com/);
  assert.throws(() => parseFigmaUrl("https://figma.com/design/abc/Test"), /node-id/);
});

test("normalizeFigmaResponse produces relative, self-contained nodes", () => {
  const doc = normalizeFigmaResponse(response, "abc123", "1:2", "2026-09-22T00:00:00.000Z");
  assert.equal(doc.schema, "figma-vault/doc@0");
  assert.equal(doc.root.layout.mode, "column");
  assert.deepEqual(doc.root.layout.padding, [16, 16, 16, 16]);
  assert.equal(doc.root.children[0]?.layout.x, 16);
  assert.equal(doc.root.children[0]?.text?.token, "label/md");
  assert.equal(doc.root.children[1]?.asset?.path, "assets/2_4.png");
  assert.equal(doc.root.children[2]?.asset?.path, "assets/2_5.svg");
  assert.equal(doc.root.children.some((node) => node.name === "Hidden"), false);
  assert.equal(countVaultNodes(doc.root), 4);
});

test("collectRenderTargets separates image fills and vectors", () => {
  const targets = collectRenderTargets(response.nodes["1:2"]!.document);
  assert.deepEqual(targets, { png: ["2:4"], svg: ["2:5"] });
});

test("normalizeFigmaResponse infers repeated colors, typography, and effects without shared styles", () => {
  const repeatedStyleResponse: FigmaNodesResponse = {
    name: "Inferred tokens",
    version: "1",
    nodes: {
      "1:1": {
        styles: {},
        document: {
          id: "1:1",
          name: "Screen",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 240 },
          children: [
            {
              id: "1:2",
              name: "Title",
              type: "TEXT",
              characters: "One",
              absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 24 },
              fills: [{ type: "SOLID", color: { r: 17 / 255, g: 34 / 255, b: 51 / 255 } }],
              effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 4, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
              style: { fontFamily: "Inter", fontSize: 16, fontWeight: 500, lineHeightPx: 24, letterSpacing: 0 },
            },
            {
              id: "1:3",
              name: "Subtitle",
              type: "TEXT",
              characters: "Two",
              absoluteBoundingBox: { x: 0, y: 32, width: 100, height: 24 },
              fills: [{ type: "SOLID", color: { r: 17 / 255, g: 34 / 255, b: 51 / 255 } }],
              effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 4, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
              style: { fontFamily: "Inter", fontSize: 16, fontWeight: 500, lineHeightPx: 24, letterSpacing: 0 },
            },
          ],
        },
      },
    },
  };

  const doc = normalizeFigmaResponse(repeatedStyleResponse, "abc", "1:1");
  assert.equal(doc.tokens.colors["inferred/color/112233"], "#112233");
  const textToken = Object.keys(doc.tokens.text).find((name) => name.startsWith("inferred/text/inter-16-500-"));
  assert.ok(textToken);
  assert.equal(doc.root.children[0]?.text?.token, textToken);
  assert.equal(doc.root.children[1]?.text?.token, textToken);
  assert.equal(Object.keys(doc.tokens.effects).length, 1);
});

test("normalizeFigmaResponse does not replace shared text tokens with inferred names", () => {
  const doc = normalizeFigmaResponse(response, "abc123", "1:2");
  assert.ok(doc.tokens.text["label/md"]);
  assert.equal(doc.root.children[0]?.text?.token, "label/md");
  assert.equal(Object.keys(doc.tokens.text).some((name) => name.startsWith("inferred/")), false);
});

test("normalizeFigmaResponse keeps gradient fills as handles and stops", () => {
  const gradientResponse: FigmaNodesResponse = {
    name: "Gradients",
    nodes: {
      "1:1": {
        document: {
          id: "1:1",
          name: "Root",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          children: [
            {
              id: "1:2",
              name: "Linear",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
              fills: [
                {
                  type: "GRADIENT_LINEAR",
                  opacity: 0.5,
                  gradientHandlePositions: [
                    { x: 0.5, y: 1 },
                    { x: 0.5, y: 0 },
                    { x: 1, y: 1 },
                  ],
                  gradientStops: [
                    { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
                    { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
                  ],
                },
              ],
            },
            {
              id: "1:3",
              name: "Radial",
              type: "ELLIPSE",
              absoluteBoundingBox: { x: 0, y: 50, width: 50, height: 50 },
              fills: [
                {
                  type: "GRADIENT_RADIAL",
                  gradientHandlePositions: [
                    { x: 0.5, y: 0.5 },
                    { x: 1, y: 0.5 },
                    { x: 0.5, y: 1 },
                  ],
                  gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }],
                },
              ],
            },
            {
              id: "1:4",
              name: "Solid wins",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 50, y: 50, width: 50, height: 50 },
              fills: [
                { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } },
                {
                  type: "GRADIENT_LINEAR",
                  gradientHandlePositions: [
                    { x: 0, y: 0 },
                    { x: 1, y: 0 },
                    { x: 0, y: 1 },
                  ],
                  gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }],
                },
              ],
            },
          ],
        },
      },
    },
  };

  const doc = normalizeFigmaResponse(gradientResponse, "abc", "1:1");
  const [linear, radial, solid] = doc.root.children;

  const linearFill = linear?.style?.fill;
  assert.ok(typeof linearFill === "object", "линейный градиент должен стать объектом");
  assert.equal(linearFill.type, "linear");
  assert.equal(linearFill.handles.length, 3);
  assert.deepEqual(linearFill.handles[1], { x: 0.5, y: 0 });
  // opacity заливки 0.5 умножается на альфу стопа
  assert.equal(linearFill.stops[0]?.color, "rgba(0,0,0,0.5)");

  const radialFill = radial?.style?.fill;
  assert.ok(typeof radialFill === "object", "радиальный градиент теряться не должен");
  assert.equal(radialFill.type, "radial");
  assert.deepEqual(radialFill.handles[2], { x: 0.5, y: 1 });

  assert.equal(solid?.style?.fill, "#0000FF", "сплошная заливка приоритетнее градиента");

  const inferredColors = Object.values(doc.tokens.colors);
  assert.equal(
    inferredColors.every((value) => typeof value === "string"),
    true,
    "градиент не должен попадать в палитру токенов",
  );
});
