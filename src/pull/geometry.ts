import { safeNodeId } from "./url.js";
import type { FigmaNode, JsonRecord } from "./types.js";

export interface GeneratedArtifact {
  relativePath: string;
  content: string | Uint8Array;
}

interface GeometryPath {
  path: string;
  windingRule?: string;
}

interface GeometryPart {
  node: FigmaNode;
  opacity: number;
}

const VECTOR_TYPES = new Set([
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "REGULAR_POLYGON",
  "STAR",
  "VECTOR",
]);

const VECTOR_CONTAINER_TYPES = new Set(["COMPONENT", "FRAME", "GROUP", "INSTANCE"]);

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter(Boolean) as JsonRecord[] : [];
}

function geometryPaths(value: unknown): GeometryPath[] {
  return records(value)
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      windingRule: typeof item.windingRule === "string" ? item.windingRule : undefined,
    }))
    .filter((item) => item.path.length > 0);
}

function hasGeometry(node: FigmaNode): boolean {
  return geometryPaths(node.fillGeometry).length > 0 || geometryPaths(node.strokeGeometry).length > 0;
}

function hasImageFill(node: FigmaNode): boolean {
  return records(node.fills).some((paint) => paint.visible !== false && paint.type === "IMAGE");
}

function nodeOpacity(node: FigmaNode): number {
  return typeof node.opacity === "number" && Number.isFinite(node.opacity) ? node.opacity : 1;
}

/**
 * Returns every drawable geometry node when the subtree is a pure vector icon.
 * Text, raster fills and non-vector leaves make the subtree ineligible: such a
 * container must remain a normal layout tree rather than being flattened.
 */
function collectGeometryParts(
  node: FigmaNode,
  inheritedOpacity = 1,
): GeometryPart[] | null {
  if (node.visible === false) return [];
  if (node.type === "TEXT" || hasImageFill(node)) return null;

  const opacity = inheritedOpacity * nodeOpacity(node);
  const parts: GeometryPart[] = hasGeometry(node) ? [{ node, opacity }] : [];
  // Figma already returns the resolved outline for boolean/vector nodes. Their
  // children are construction operands and would duplicate the visible path.
  if (parts.length > 0 && VECTOR_TYPES.has(node.type)) return parts;
  const children = (node.children ?? []).filter((child) => child.visible !== false);

  if (children.length === 0) return parts.length > 0 ? parts : null;
  if (!VECTOR_CONTAINER_TYPES.has(node.type) && !VECTOR_TYPES.has(node.type)) return null;

  for (const child of children) {
    const childParts = collectGeometryParts(child, opacity);
    if (childParts === null) return null;
    parts.push(...childParts);
  }
  return parts.length > 0 ? parts : null;
}

export function canGenerateSvgAsset(node: FigmaNode): boolean {
  if (!VECTOR_TYPES.has(node.type) && !VECTOR_CONTAINER_TYPES.has(node.type)) return false;
  if (!node.absoluteBoundingBox && !node.absoluteRenderBounds) return false;
  return collectGeometryParts(node) !== null;
}

export function needsRemoteSvgRender(node: FigmaNode): boolean {
  return VECTOR_TYPES.has(node.type) && !hasGeometry(node);
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function byte(value: unknown): number {
  return Math.max(0, Math.min(255, Math.round(number(value) * 255)));
}

function solidPaint(value: unknown, opacity: number): string | undefined {
  const paint = records(value).find((item) => item.visible !== false && item.type === "SOLID");
  const color = record(paint?.color);
  if (!paint || !color) return undefined;

  const rgb = [byte(color.r), byte(color.g), byte(color.b)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
  const alpha = Math.max(0, Math.min(1, number(color.a, 1) * number(paint.opacity, 1) * opacity));
  if (alpha >= 0.999) return `#${rgb}`;
  return `#${rgb}${byte(alpha).toString(16).padStart(2, "0")}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function pathElements(node: FigmaNode, opacity: number): string {
  const fill = solidPaint(node.fills, opacity) ?? "currentColor";
  const stroke = solidPaint(node.strokes, opacity) ?? fill;
  const fillPaths = geometryPaths(node.fillGeometry).map((item) =>
    `<path d="${escapeAttribute(item.path)}" fill="${fill}"${
      item.windingRule === "EVENODD" ? ' fill-rule="evenodd" clip-rule="evenodd"' : ""
    }/>`);
  const strokePaths = geometryPaths(node.strokeGeometry).map((item) =>
    `<path d="${escapeAttribute(item.path)}" fill="${stroke}"${
      item.windingRule === "EVENODD" ? ' fill-rule="evenodd" clip-rule="evenodd"' : ""
    }/>`);
  return [...fillPaths, ...strokePaths].join("");
}

function pathNumbers(value: string): number[] {
  return (value.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [])
    .map(Number)
    .filter(Number.isFinite);
}

function expandedViewBox(root: FigmaNode, parts: GeometryPart[]): [number, number, number, number] {
  const box = root.absoluteBoundingBox ?? root.absoluteRenderBounds;
  const width = Math.max(number(box?.width), 0.01);
  const height = Math.max(number(box?.height), 0.01);
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;

  for (const part of parts) {
    const partBox = part.node.absoluteBoundingBox ?? part.node.absoluteRenderBounds;
    const dx = number(partBox?.x) - number(box?.x);
    const dy = number(partBox?.y) - number(box?.y);
    const paths = [
      ...geometryPaths(part.node.fillGeometry),
      ...geometryPaths(part.node.strokeGeometry),
    ];
    for (const geometry of paths) {
      const values = pathNumbers(geometry.path);
      for (let index = 0; index + 1 < values.length; index += 2) {
        minX = Math.min(minX, dx + values[index]!);
        minY = Math.min(minY, dy + values[index + 1]!);
        maxX = Math.max(maxX, dx + values[index]!);
        maxY = Math.max(maxY, dy + values[index + 1]!);
      }
    }
  }
  return [round(minX), round(minY), round(maxX - minX), round(maxY - minY)];
}

function svgForNode(node: FigmaNode, parts: GeometryPart[]): string {
  const box = node.absoluteBoundingBox ?? node.absoluteRenderBounds;
  const width = round(Math.max(number(box?.width), 0.01));
  const height = round(Math.max(number(box?.height), 0.01));
  const body = parts.map((part) => {
    const partBox = part.node.absoluteBoundingBox ?? part.node.absoluteRenderBounds;
    const dx = round(number(partBox?.x) - number(box?.x));
    const dy = round(number(partBox?.y) - number(box?.y));
    const paths = pathElements(part.node, part.opacity);
    return dx === 0 && dy === 0 ? paths : `<g transform="translate(${dx} ${dy})">${paths}</g>`;
  }).join("");
  const viewBox = expandedViewBox(node, parts).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" fill="none">${body}</svg>\n`;
}

export function collectGeneratedSvgArtifacts(root: FigmaNode): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];

  function visit(node: FigmaNode): void {
    if (node.visible === false) return;
    if (canGenerateSvgAsset(node)) {
      const parts = collectGeometryParts(node);
      if (parts) {
        artifacts.push({
          relativePath: `assets/${safeNodeId(node.id)}.svg`,
          content: svgForNode(node, parts),
        });
      }
    }
    for (const child of node.children ?? []) visit(child);
  }

  visit(root);
  return artifacts;
}
