import type { VaultDocument, VaultNode } from "./types.js";

export interface DomSnapshot {
  schema: "figma-vault/snapshot@0";
  /** null when no element is marked as the Figma root. */
  root: string | null;
  viewport: { w: number; h: number };
  /** Visible DOM text, in reading order. Styled spans may be separate entries. */
  texts: string[];
  /** Page rectangles relative to the element marked with the Figma root id. */
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

export interface VerifyTextIssue {
  id: string;
  name: string;
  content: string;
}

export interface VerifyGeometryIssue {
  id: string;
  name: string;
  property: "x" | "y" | "w" | "h";
  expected: number;
  actual: number;
  delta: number;
}

export interface VerifyReport {
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  text: { total: number; matched: number; missing: VerifyTextIssue[] };
  geometry: {
    visibleNodes: number;
    mappedNodes: number;
    checkedNodes: number;
    missingRoot: boolean;
    mismatches: VerifyGeometryIssue[];
  };
  warnings: string[];
}

interface ExpectedNode {
  node: VaultNode;
  box: { x: number; y: number; w: number; h: number };
}

function normalizeText(value: string): string {
  return value.replace(/[\s\u00a0]+/gu, " ").trim();
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function hasWordBoundaries(haystack: string, needle: string, index: number): boolean {
  const before = index > 0 ? haystack[index - 1] : undefined;
  const after = haystack[index + needle.length];
  return !(isWordCharacter(before) && isWordCharacter(needle[0]))
    && !(isWordCharacter(after) && isWordCharacter(needle[needle.length - 1]));
}

function textInventory(doc: VaultDocument): VerifyTextIssue[] {
  const texts: VerifyTextIssue[] = [];
  function visit(node: VaultNode, hidden: boolean): void {
    const effectivelyHidden = hidden || node.hidden === true;
    if (effectivelyHidden) return;
    const content = normalizeText(node.text?.content ?? "");
    if (content) texts.push({ id: node.id, name: node.name, content });
    for (const child of node.children) visit(child, effectivelyHidden);
  }
  visit(doc.root, false);
  return texts;
}

function geometryInventory(doc: VaultDocument): ExpectedNode[] {
  const nodes: ExpectedNode[] = [];
  function visit(node: VaultNode, x: number, y: number, hidden: boolean): void {
    const effectivelyHidden = hidden || node.hidden === true;
    if (effectivelyHidden) return;
    const absoluteX = x + node.layout.x;
    const absoluteY = y + node.layout.y;
    nodes.push({ node, box: { x: absoluteX, y: absoluteY, w: node.layout.w, h: node.layout.h } });
    for (const child of node.children) visit(child, absoluteX, absoluteY, effectivelyHidden);
  }
  visit(doc.root, -doc.root.layout.x, -doc.root.layout.y, false);
  return nodes;
}

function validateSnapshot(snapshot: DomSnapshot): void {
  if (snapshot?.schema !== "figma-vault/snapshot@0") {
    throw new Error("Expected figma-vault/snapshot@0");
  }
  if (snapshot.root !== null && typeof snapshot.root !== "string") {
    throw new Error("Snapshot root must be a node id or null");
  }
  if (!snapshot.viewport || !Number.isFinite(snapshot.viewport.w) || !Number.isFinite(snapshot.viewport.h)) {
    throw new Error("Snapshot viewport must contain finite w and h");
  }
  if (!Array.isArray(snapshot.texts) || !snapshot.texts.every((value) => typeof value === "string")) {
    throw new Error("Snapshot texts must be an array of strings");
  }
  if (!Array.isArray(snapshot.nodes) || !snapshot.nodes.every((item) =>
    item && typeof item.id === "string" && [item.x, item.y, item.w, item.h].every(Number.isFinite))) {
    throw new Error("Snapshot nodes must have id and finite x, y, w, h");
  }
}

/**
 * Compare a rendered browser snapshot with visible Figma structure. Text is
 * checked across the whole page; geometry is checked only for explicit id links.
 * No browser dependency is needed in the package.
 */
export function verifySnapshot(
  doc: VaultDocument,
  snapshot: DomSnapshot,
  options: { tolerancePx?: number } = {},
): VerifyReport {
  validateSnapshot(snapshot);
  const tolerance = options.tolerancePx ?? 2;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("tolerancePx must be a finite number >= 0");
  }

  const expectedTexts = textInventory(doc);
  const pageText = normalizeText(snapshot.texts.join(" "));
  const occupied: Array<{ start: number; end: number }> = [];
  const missing: VerifyTextIssue[] = [];
  // Match longest strings first so a short label cannot consume part of a heading.
  const orderedTexts = [...expectedTexts].sort((a, b) => b.content.length - a.content.length);
  for (const expected of orderedTexts) {
    let found = -1;
    let cursor = 0;
    while (cursor <= pageText.length - expected.content.length) {
      const index = pageText.indexOf(expected.content, cursor);
      if (index < 0) break;
      const end = index + expected.content.length;
      if (hasWordBoundaries(pageText, expected.content, index)
        && occupied.every((range) => end <= range.start || index >= range.end)) {
        found = index;
        occupied.push({ start: index, end });
        break;
      }
      cursor = index + 1;
    }
    if (found < 0) missing.push(expected);
  }

  const expectedNodes = geometryInventory(doc);
  const snapshotNodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const missingRoot = snapshot.root !== doc.root.id || !snapshotNodes.has(doc.root.id);
  const mismatches: VerifyGeometryIssue[] = [];
  let checkedNodes = 0;
  for (const expected of expectedNodes) {
    const actual = snapshotNodes.get(expected.node.id);
    if (!actual) continue;
    checkedNodes += 1;
    for (const property of ["x", "y", "w", "h"] as const) {
      const delta = Math.abs(expected.box[property] - actual[property]);
      if (delta > tolerance) {
        mismatches.push({
          id: expected.node.id,
          name: expected.node.name,
          property,
          expected: expected.box[property],
          actual: actual[property],
          delta: Math.round(delta * 100) / 100,
        });
      }
    }
  }

  const mappedNodes = expectedNodes.filter((item) => snapshotNodes.has(item.node.id)).length;
  const warnings: string[] = [];
  if (missingRoot) warnings.push(`Root node ${doc.root.id} has no data-figma-node-id mapping`);
  if (mappedNodes < 2) warnings.push("Map the root and at least one child block to verify geometry");
  if (snapshotNodes.size !== snapshot.nodes.length) warnings.push("Snapshot contains duplicate node ids");
  const failed = missing.length > 0 || mismatches.length > 0 || snapshotNodes.size !== snapshot.nodes.length;
  const incomplete = missingRoot || mappedNodes < 2;

  return {
    verdict: failed ? "FAIL" : incomplete ? "INCOMPLETE" : "PASS",
    text: { total: expectedTexts.length, matched: expectedTexts.length - missing.length, missing },
    geometry: { visibleNodes: expectedNodes.length, mappedNodes, checkedNodes, missingRoot, mismatches },
    warnings,
  };
}
