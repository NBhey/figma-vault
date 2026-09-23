/**
 * Зеркало формата `figma-vault/doc@0` и `doc@1` из `docs/CONTRACT.md`.
 * doc@1 — надмножество doc@0: `hidden`, `text.runs`, градиенты в `style.fill`/`style.stroke`.
 * MCP-сервер читает vault и ничего в него не пишет, поэтому типы здесь — только для чтения.
 */

export type VaultNodeType = "frame" | "text" | "image" | "vector" | "group" | "instance";

export interface VaultLayout {
  mode: "none" | "row" | "column";
  x: number;
  y: number;
  w: number;
  h: number;
  gap?: number;
  padding?: [number, number, number, number];
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  grow?: number;
  wrap?: boolean;
}

/** Градиент: три ручки Figma в координатах рамки узла, стопы по возрастанию `at`. */
export interface VaultGradient {
  type: "linear" | "radial" | "angular" | "diamond";
  handles: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  stops: Array<{ at: number; color: string }>;
}

export interface VaultStyle {
  fill?: string | VaultGradient;
  stroke?: string | VaultGradient;
  strokeWidth?: number;
  radius?: [number, number, number, number];
  opacity?: number;
  shadow?: string;
  blur?: number;
}

/** Фрагмент текста со своим оформлением, индексы — по `text.content` в единицах JS-строки. */
export interface VaultTextRun {
  start: number;
  end: number;
  color?: string;
  weight?: number;
}

export interface VaultText {
  content: string;
  token?: string;
  color?: string;
  align?: "left" | "center" | "right";
  font?: string;
  size?: number;
  weight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  runs?: VaultTextRun[];
}

export interface VaultAsset {
  path: string;
  w: number;
  h: number;
}

export interface VaultNode {
  id: string;
  name: string;
  type: VaultNodeType;
  component?: string;
  layout: VaultLayout;
  style?: VaultStyle;
  text?: VaultText;
  asset?: VaultAsset;
  children?: VaultNode[];
  /** doc@1: узел выключен в Figma. У видимых узлов поля нет. */
  hidden?: true;
  /** Ставится только в ответах MCP, когда скрытые дети не отданы (`includeHidden: false`). */
  hiddenOmitted?: number;
  /** Ставится только в ответе `vault_get_doc` при обрезке по `maxDepth`. В doc.json не встречается. */
  childrenOmitted?: number;
}

export interface VaultTextToken {
  font?: string;
  size?: number;
  weight?: number;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface VaultTokens {
  colors: Record<string, string>;
  text: Record<string, VaultTextToken>;
  effects: Record<string, string>;
}

export interface VaultSource {
  fileKey: string;
  nodeId: string;
  fileName: string;
  nodeName: string;
  exportedAt: string;
  figmaVersion: string;
}

export interface VaultDocument {
  schema: "figma-vault/doc@0" | "figma-vault/doc@1";
  source: VaultSource;
  tokens: VaultTokens;
  root: VaultNode;
}

export interface VaultIndexEntry {
  docId: string;
  fileKey: string;
  nodeId: string;
  fileName: string;
  nodeName: string;
  exportedAt: string;
  nodeCount: number;
}

export interface VaultIndex {
  schema: "figma-vault/index@0";
  docs: VaultIndexEntry[];
}

/** Документ, обрезанный по глубине: сам документ плюс отчёт об обрезке. */
export interface TruncatedDocument extends VaultDocument {
  truncation?: {
    maxDepth: number;
    omittedNodes: number;
  };
  /** Сколько узлов не отдано, потому что они скрыты. Нет поля — скрытых не было или они отданы. */
  hidden?: {
    omittedNodes: number;
  };
}

export interface SearchHit {
  id: string;
  name: string;
  type: VaultNodeType;
  /** Где нашлось: имя узла и/или текстовое содержимое. */
  matchedIn: Array<"name" | "text">;
  /** Путь от корня: имена предков, включая сам узел. */
  path: string[];
  text?: string;
  /** Только при `includeHidden`: узел скрыт сам или лежит внутри скрытого. */
  hidden?: true;
}

export interface SearchResult {
  docId: string;
  query: string;
  total: number;
  returned: number;
  hits: SearchHit[];
}

export interface AssetPayload {
  path: string;
  mimeType: string;
  bytes: number;
  /** base64 для растра; для svg тут исходник в utf8. */
  data: string;
  encoding: "base64" | "utf8";
}
