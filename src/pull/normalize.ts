import { safeNodeId } from "./url.js";
import { canGenerateSvgAsset, needsRemoteSvgRender } from "./geometry.js";
import type {
  FigmaNode,
  FigmaNodeEntry,
  FigmaNodesResponse,
  FigmaRect,
  JsonRecord,
  RenderTargets,
  VaultDocument,
  VaultNode,
  VaultGradient,
  VaultGradientStop,
  VaultPoint,
  VaultStyle,
  VaultText,
  VaultTextRun,
  VaultTokens,
} from "./types.js";

const VECTOR_TYPES = new Set([
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "STAR",
  "VECTOR",
]);

const FRAME_TYPES = new Set([
  "COMPONENT",
  "COMPONENT_SET",
  "FRAME",
  "SECTION",
]);

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter(Boolean) as JsonRecord[] : [];
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rounded(value: unknown, fallback = 0): number {
  const parsed = number(value) ?? fallback;
  return Math.round(parsed * 100) / 100;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstVisiblePaint(value: unknown, type?: string): JsonRecord | undefined {
  return records(value).find((paint) => paint.visible !== false && (!type || paint.type === type));
}

function colorChannel(value: unknown): number {
  return Math.max(0, Math.min(255, Math.round((number(value) ?? 0) * 255)));
}

function colorToCss(paint: JsonRecord | undefined): string | undefined {
  if (!paint || paint.type !== "SOLID") return undefined;
  const color = record(paint.color);
  if (!color) return undefined;

  const r = colorChannel(color.r);
  const g = colorChannel(color.g);
  const b = colorChannel(color.b);
  const alpha = rounded((number(color.a) ?? 1) * (number(paint.opacity) ?? 1), 1);
  if (alpha < 1) return `rgba(${r},${g},${b},${alpha})`;
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const GRADIENT_TYPES: Record<string, VaultGradient["type"]> = {
  GRADIENT_LINEAR: "linear",
  GRADIENT_RADIAL: "radial",
  GRADIENT_ANGULAR: "angular",
  GRADIENT_DIAMOND: "diamond",
};

function firstVisibleGradient(value: unknown): JsonRecord | undefined {
  return records(value).find(
    (paint) => paint.visible !== false && GRADIENT_TYPES[String(paint.type)] !== undefined,
  );
}

function paintToGradient(paint: JsonRecord | undefined): VaultGradient | undefined {
  if (!paint) return undefined;
  const type = GRADIENT_TYPES[String(paint.type)];
  if (!type) return undefined;

  const handles = records(paint.gradientHandlePositions)
    .slice(0, 3)
    .map((handle) => ({ x: rounded(handle.x), y: rounded(handle.y) }));
  if (handles.length !== 3) return undefined;

  // Прозрачность самой заливки умножается на альфу каждого стопа.
  const opacity = number(paint.opacity) ?? 1;
  const stops = records(paint.gradientStops)
    .map((stop) => ({
      at: rounded(stop.position),
      color: colorToCss({ type: "SOLID", color: stop.color, opacity }),
    }))
    .filter((stop): stop is VaultGradientStop => stop.color !== undefined);
  if (stops.length === 0) return undefined;

  return { type, handles: handles as [VaultPoint, VaultPoint, VaultPoint], stops };
}

function shadowToCss(effect: JsonRecord | undefined): string | undefined {
  if (!effect || (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW")) return undefined;
  const offset = record(effect.offset);
  const color = colorToCss({ type: "SOLID", color: effect.color });
  if (!color) return undefined;
  const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
  return `${inset}${rounded(offset?.x)}px ${rounded(offset?.y)}px ${rounded(effect.radius)}px ${rounded(effect.spread)}px ${color}`;
}

function nodeBounds(node: FigmaNode): FigmaRect {
  const bounds = node.absoluteBoundingBox ?? node.absoluteRenderBounds;
  return bounds ?? { x: 0, y: 0, width: 0, height: 0 };
}

function mapNodeType(node: FigmaNode): VaultNode["type"] {
  if (node.type === "TEXT") return "text";
  if (node.type === "INSTANCE") return "instance";
  if (firstVisiblePaint(node.fills, "IMAGE")) return "image";
  if (VECTOR_TYPES.has(node.type)) return "vector";
  if (node.type === "GROUP") return "group";
  if (FRAME_TYPES.has(node.type)) return "frame";
  return node.children?.length ? "group" : "vector";
}

function mapAlignment(value: unknown): "start" | "center" | "end" | "stretch" | undefined {
  switch (value) {
    case "MIN": return "start";
    case "CENTER": return "center";
    case "MAX": return "end";
    case "STRETCH": return "stretch";
    default: return undefined;
  }
}

function mapJustification(value: unknown): "start" | "center" | "end" | "between" | undefined {
  switch (value) {
    case "MIN": return "start";
    case "CENTER": return "center";
    case "MAX": return "end";
    case "SPACE_BETWEEN": return "between";
    default: return undefined;
  }
}

function mapTextAlignment(value: unknown): VaultText["align"] {
  switch (value) {
    case "CENTER": return "center";
    case "RIGHT": return "right";
    default: return "left";
  }
}

function radius(node: FigmaNode): [number, number, number, number] | undefined {
  const radii = [
    number(node.topLeftRadius),
    number(node.topRightRadius),
    number(node.bottomRightRadius),
    number(node.bottomLeftRadius),
  ];
  if (radii.every((value) => value !== undefined)) {
    return radii.map((value) => rounded(value)) as [number, number, number, number];
  }
  const common = number(node.cornerRadius);
  return common === undefined ? undefined : [rounded(common), rounded(common), rounded(common), rounded(common)];
}

function mapStyle(node: FigmaNode): VaultStyle | undefined {
  const solidFill = colorToCss(firstVisiblePaint(node.fills, "SOLID"));
  const solidStroke = colorToCss(firstVisiblePaint(node.strokes, "SOLID"));
  // Сплошная заливка приоритетнее: градиент подставляется только когда её нет.
  const gradientFill = solidFill === undefined ? paintToGradient(firstVisibleGradient(node.fills)) : undefined;
  const gradientStroke = solidStroke === undefined ? paintToGradient(firstVisibleGradient(node.strokes)) : undefined;
  const effects = records(node.effects).filter((effect) => effect.visible !== false);
  const shadow = shadowToCss(effects.find((effect) => effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW"));
  const blur = effects.find((effect) => effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR");

  const result: VaultStyle = {
    fill: solidFill ?? gradientFill,
    stroke: solidStroke ?? gradientStroke,
    strokeWidth: number(node.strokeWeight) === undefined ? undefined : rounded(node.strokeWeight),
    radius: radius(node),
    opacity: number(node.opacity) === undefined ? undefined : rounded(node.opacity, 1),
    shadow,
    blur: blur ? rounded(blur.radius) : undefined,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function styleName(node: FigmaNode, kind: "fill" | "text" | "effect", styles: Record<string, JsonRecord>): string | undefined {
  const refs = record(node.styles);
  const styleId = text(refs?.[kind]);
  return styleId ? text(styles[styleId]?.name) : undefined;
}

function mapText(node: FigmaNode, styles: Record<string, JsonRecord>): VaultText | undefined {
  if (node.type !== "TEXT") return undefined;
  const source = record(node.style) ?? {};
  const fontSize = number(source.fontSize);
  const rawWeight = number(source.fontWeight) ?? Number.parseInt(String(source.fontWeight ?? ""), 10);
  const weight = Number.isFinite(rawWeight) ? rounded(rawWeight) : undefined;
  const content = typeof node.characters === "string" ? node.characters : "";
  const baseColor = colorToCss(firstVisiblePaint(node.fills, "SOLID"));
  const runs = mapTextRuns(node, content, baseColor, weight);
  return {
    content,
    token: styleName(node, "text", styles),
    color: runs?.[0]?.color ?? baseColor,
    runs,
    align: mapTextAlignment(source.textAlignHorizontal),
    font: text(source.fontFamily),
    size: fontSize === undefined ? undefined : rounded(fontSize),
    weight,
    lineHeight: number(source.lineHeightPx) === undefined ? undefined : rounded(source.lineHeightPx),
    letterSpacing: number(source.letterSpacing) === undefined ? undefined : rounded(source.letterSpacing),
  };
}

function mapTextRuns(
  node: FigmaNode,
  content: string,
  baseColor: string | undefined,
  baseWeight: number | undefined,
): VaultTextRun[] | undefined {
  const overrides = Array.isArray(node.characterStyleOverrides) ? node.characterStyleOverrides : [];
  const table = record(node.styleOverrideTable) ?? {};
  if (content.length === 0 || overrides.length === 0) return undefined;

  const runs: VaultTextRun[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const overrideId = number(overrides[index]) ?? 0;
    const override = overrideId === 0 ? undefined : record(table[String(overrideId)]);
    const color = colorToCss(firstVisiblePaint(override?.fills, "SOLID")) ?? baseColor;
    const rawWeight = override ? number(override.fontWeight) : undefined;
    const weight = rawWeight === undefined ? baseWeight : rounded(rawWeight);
    const last = runs[runs.length - 1];
    if (last && last.color === color && last.weight === weight) {
      last.end = index + 1;
    } else {
      runs.push({ start: index, end: index + 1, color, weight });
    }
  }

  // No visual variation: keep the small doc@0 representation.
  if (runs.length === 1 && runs[0]?.color === baseColor && runs[0]?.weight === baseWeight) {
    return undefined;
  }
  return runs;
}

function componentName(node: FigmaNode, components: Record<string, JsonRecord>): string | undefined {
  const componentId = text(node.componentId);
  return componentId ? text(components[componentId]?.name) : undefined;
}

function assetFor(node: FigmaNode, mappedType: VaultNode["type"], bounds: FigmaRect): VaultNode["asset"] {
  if (mappedType === "image") {
    return { path: `assets/${safeNodeId(node.id)}.png`, w: rounded(bounds.width), h: rounded(bounds.height) };
  }
  if ((mappedType === "vector" && VECTOR_TYPES.has(node.type)) || canGenerateSvgAsset(node)) {
    return { path: `assets/${safeNodeId(node.id)}.svg`, w: rounded(bounds.width), h: rounded(bounds.height) };
  }
  return undefined;
}

function normalizeNode(
  node: FigmaNode,
  parentBounds: FigmaRect | undefined,
  entry: FigmaNodeEntry,
  isRoot = false,
  ancestorHidden = false,
): VaultNode | null {
  const hidden = node.visible === false;
  const bounds = nodeBounds(node);
  const mappedType = mapNodeType(node);
  const styles = entry.styles ?? {};
  const children = (node.children ?? [])
    .map((child) => normalizeNode(child, bounds, entry, false, ancestorHidden || hidden))
    .filter((child): child is VaultNode => child !== null);
  const style = mapStyle(node);
  const nodeText = mapText(node, styles);
  // Hidden slots remain structural data; fetching their visual assets would
  // consume the limited image-render budget for content absent from the screen.
  const asset = ancestorHidden || hidden ? undefined : assetFor(node, mappedType, bounds);

  if (!isRoot && !hidden && !ancestorHidden && bounds.width === 0 && bounds.height === 0 && children.length === 0 && !nodeText) return null;
  if (!isRoot && !hidden && !ancestorHidden && mappedType === "group" && children.length === 0 && !style && !asset) return null;

  const mode = node.layoutMode === "HORIZONTAL" ? "row" : node.layoutMode === "VERTICAL" ? "column" : "none";
  const parentX = parentBounds?.x ?? bounds.x;
  const parentY = parentBounds?.y ?? bounds.y;
  const padding: [number, number, number, number] = [
    rounded(node.paddingTop),
    rounded(node.paddingRight),
    rounded(node.paddingBottom),
    rounded(node.paddingLeft),
  ];

  return {
    id: node.id,
    name: node.name,
    type: mappedType,
    component: componentName(node, entry.components ?? {}),
    layout: {
      mode,
      x: rounded(bounds.x - parentX),
      y: rounded(bounds.y - parentY),
      w: rounded(bounds.width),
      h: rounded(bounds.height),
      gap: mode === "none" ? undefined : rounded(node.itemSpacing),
      padding: mode === "none" ? undefined : padding,
      align: mode === "none" ? undefined : mapAlignment(node.counterAxisAlignItems),
      justify: mode === "none" ? undefined : mapJustification(node.primaryAxisAlignItems),
      grow: number(node.layoutGrow) === undefined ? undefined : rounded(node.layoutGrow),
      wrap: mode === "none" ? undefined : node.layoutWrap === "WRAP",
    },
    style,
    text: nodeText,
    asset,
    hidden: hidden ? true : undefined,
    children,
  };
}

function visit(node: FigmaNode, callback: (node: FigmaNode) => void): void {
  if (node.visible === false) return;
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function extractTokens(root: FigmaNode, entry: FigmaNodeEntry): VaultTokens {
  const tokens: VaultTokens = { colors: {}, text: {}, effects: {} };
  const styles = entry.styles ?? {};
  visit(root, (node) => {
    const fillToken = styleName(node, "fill", styles);
    const fill = colorToCss(firstVisiblePaint(node.fills, "SOLID"));
    if (fillToken && fill) tokens.colors[fillToken] = fill;

    const textToken = styleName(node, "text", styles);
    const normalizedText = mapText(node, styles);
    if (textToken && normalizedText) {
      tokens.text[textToken] = {
        font: normalizedText.font,
        size: normalizedText.size,
        weight: normalizedText.weight,
        lineHeight: normalizedText.lineHeight,
        letterSpacing: normalizedText.letterSpacing,
      };
    }

    const effectToken = styleName(node, "effect", styles);
    const effect = records(node.effects).find((item) => item.visible !== false && (item.type === "DROP_SHADOW" || item.type === "INNER_SHADOW"));
    const shadow = shadowToCss(effect);
    if (effectToken && shadow) tokens.effects[effectToken] = shadow;
  });
  return tokens;
}

function visitVault(node: VaultNode, callback: (node: VaultNode) => void): void {
  callback(node);
  for (const child of node.children) visitVault(child, callback);
}

interface CountedValue<T> {
  value: T;
  count: number;
}

function countValue<T>(counts: Map<string, CountedValue<T>>, signature: string, value: T): void {
  const existing = counts.get(signature);
  if (existing) existing.count += 1;
  else counts.set(signature, { value, count: 1 });
}

function repeatedValues<T>(counts: Map<string, CountedValue<T>>): Array<[string, CountedValue<T>]> {
  return [...counts.entries()]
    .filter(([, item]) => item.count >= 2)
    .sort(([signatureA, itemA], [signatureB, itemB]) =>
      itemB.count - itemA.count || signatureA.localeCompare(signatureB));
}

function tokenSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "value";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function inferTokens(root: VaultNode, tokens: VaultTokens): VaultTokens {
  const colorCounts = new Map<string, CountedValue<string>>();
  const textCounts = new Map<string, CountedValue<VaultTokens["text"][string]>>();
  const effectCounts = new Map<string, CountedValue<string>>();

  visitVault(root, (node) => {
    // Градиент — не цвет, в палитру токенов он не идёт.
    for (const color of [node.style?.fill, node.style?.stroke, node.text?.color]) {
      if (typeof color === "string") countValue(colorCounts, color, color);
    }

    if (node.text?.font && node.text.size !== undefined && node.text.weight !== undefined) {
      const value: VaultTokens["text"][string] = {
        font: node.text.font,
        size: node.text.size,
        weight: node.text.weight,
        lineHeight: node.text.lineHeight,
        letterSpacing: node.text.letterSpacing,
      };
      countValue(textCounts, JSON.stringify(value), value);
    }

    if (node.style?.shadow) countValue(effectCounts, node.style.shadow, node.style.shadow);
  });

  if (Object.keys(tokens.colors).length === 0) {
    for (const [, item] of repeatedValues(colorCounts)) {
      tokens.colors[`inferred/color/${tokenSlug(item.value)}`] = item.value;
    }
  }

  const inferredTextNames = new Map<string, string>();
  if (Object.keys(tokens.text).length === 0) {
    for (const [signature, item] of repeatedValues(textCounts)) {
      const font = tokenSlug(item.value.font ?? "font");
      const name = `inferred/text/${font}-${item.value.size}-${item.value.weight}-${stableHash(signature).slice(0, 6)}`;
      tokens.text[name] = item.value;
      inferredTextNames.set(signature, name);
    }

    visitVault(root, (node) => {
      if (!node.text || node.text.token || !node.text.font || node.text.size === undefined || node.text.weight === undefined) return;
      const signature = JSON.stringify({
        font: node.text.font,
        size: node.text.size,
        weight: node.text.weight,
        lineHeight: node.text.lineHeight,
        letterSpacing: node.text.letterSpacing,
      });
      node.text.token = inferredTextNames.get(signature);
    });
  }

  if (Object.keys(tokens.effects).length === 0) {
    for (const [signature, item] of repeatedValues(effectCounts)) {
      tokens.effects[`inferred/effect/${stableHash(signature)}`] = item.value;
    }
  }

  return tokens;
}

export function normalizeFigmaResponse(
  response: FigmaNodesResponse,
  fileKey: string,
  nodeId: string,
  exportedAt = new Date().toISOString(),
): VaultDocument {
  const entry = response.nodes[nodeId];
  if (!entry?.document) throw new Error(`Figma did not return node ${nodeId}`);
  const root = normalizeNode(entry.document, undefined, entry, true);
  if (!root) throw new Error(`Figma node ${nodeId} has no visible content`);

  const tokens = inferTokens(root, extractTokens(entry.document, entry));

  return {
    schema: "figma-vault/doc@1",
    source: {
      fileKey,
      nodeId,
      fileName: response.name,
      nodeName: entry.document.name,
      exportedAt,
      figmaVersion: response.version ?? "",
    },
    tokens,
    root,
  };
}

export function collectRenderTargets(root: FigmaNode): RenderTargets {
  const png = new Set<string>();
  const svg = new Set<string>();
  visit(root, (node) => {
    if (firstVisiblePaint(node.fills, "IMAGE")) png.add(node.id);
    else if (needsRemoteSvgRender(node)) svg.add(node.id);
  });
  return { png: [...png], svg: [...svg] };
}

export function countVaultNodes(root: VaultNode): number {
  return 1 + root.children.reduce((total, child) => total + countVaultNodes(child), 0);
}
