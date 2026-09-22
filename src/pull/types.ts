export type JsonRecord = Record<string, unknown>;

export interface FigmaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaNode extends JsonRecord {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: FigmaRect;
  absoluteRenderBounds?: FigmaRect;
  fills?: unknown;
  strokes?: unknown;
  effects?: unknown;
  style?: JsonRecord;
  styles?: JsonRecord;
}

export interface FigmaNodeEntry extends JsonRecord {
  document: FigmaNode;
  components?: Record<string, JsonRecord>;
  componentSets?: Record<string, JsonRecord>;
  styles?: Record<string, JsonRecord>;
}

export interface FigmaNodesResponse extends JsonRecord {
  name: string;
  version?: string;
  lastModified?: string;
  nodes: Record<string, FigmaNodeEntry | null>;
}

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

export interface VaultStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: [number, number, number, number];
  opacity?: number;
  shadow?: string;
  blur?: number;
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
}

export interface VaultNode {
  id: string;
  name: string;
  type: "frame" | "text" | "image" | "vector" | "group" | "instance";
  component?: string;
  layout: VaultLayout;
  style?: VaultStyle;
  text?: VaultText;
  asset?: { path: string; w: number; h: number };
  children: VaultNode[];
}

export interface VaultTokens {
  colors: Record<string, string>;
  text: Record<
    string,
    {
      font?: string;
      size?: number;
      weight?: number;
      lineHeight?: number;
      letterSpacing?: number;
    }
  >;
  effects: Record<string, string>;
}

export interface VaultDocument {
  schema: "figma-vault/doc@0";
  source: {
    fileKey: string;
    nodeId: string;
    fileName: string;
    nodeName: string;
    exportedAt: string;
    figmaVersion: string;
  };
  tokens: VaultTokens;
  root: VaultNode;
}

export interface SnapshotIndexEntry {
  docId: string;
  fileKey: string;
  nodeId: string;
  fileName: string;
  nodeName: string;
  exportedAt: string;
  nodeCount: number;
}

export interface SnapshotIndex {
  schema: "figma-vault/index@0";
  docs: SnapshotIndexEntry[];
}

export interface RenderTargets {
  png: string[];
  svg: string[];
}

