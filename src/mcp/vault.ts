import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateVaultDocument, validateVaultIndex, VaultValidationError } from "../shared/index.js";
import type {
  AssetPayload,
  SearchHit,
  SearchResult,
  TruncatedDocument,
  VaultDocument,
  VaultIndex,
  VaultNode,
  VaultTokens,
} from "./types.js";

/** Ошибка, текст которой безопасно отдавать агенту как есть. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

const DOC_ID_RE = /^[A-Za-z0-9._-]+$/;

const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function assertDocId(docId: string): void {
  if (!DOC_ID_RE.test(docId)) {
    throw new VaultError(`Некорректный docId: ${JSON.stringify(docId)}`);
  }
}

function cloneNode(node: VaultNode): VaultNode {
  const copy: VaultNode = { ...node };
  delete copy.children;
  return copy;
}

function countNodes(node: VaultNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/**
 * Копия поддерева не глубже `maxDepth` уровней ниже корня.
 * У узлов, чьи дети отброшены, проставляется `childrenOmitted`.
 */
function truncate(node: VaultNode, maxDepth: number, omitted: { count: number }): VaultNode {
  const copy = cloneNode(node);
  const children = node.children ?? [];
  if (maxDepth <= 0) {
    if (children.length > 0) {
      copy.children = [];
      copy.childrenOmitted = children.length;
      for (const child of children) omitted.count += countNodes(child);
    }
    return copy;
  }
  copy.children = children.map((child) => truncate(child, maxDepth - 1, omitted));
  return copy;
}

function findNode(node: VaultNode, nodeId: string): VaultNode | undefined {
  if (node.id === nodeId) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, nodeId);
    if (hit) return hit;
  }
  return undefined;
}

function collectHits(node: VaultNode, needle: string, trail: string[], hits: SearchHit[]): void {
  const path_ = [...trail, node.name];
  const matchedIn: Array<"name" | "text"> = [];
  if (node.name.toLowerCase().includes(needle)) matchedIn.push("name");
  const content = node.text?.content;
  if (content && content.toLowerCase().includes(needle)) matchedIn.push("text");
  if (matchedIn.length > 0) {
    const hit: SearchHit = { id: node.id, name: node.name, type: node.type, matchedIn, path: path_ };
    if (content !== undefined) hit.text = content;
    hits.push(hit);
  }
  for (const child of node.children ?? []) collectHits(child, needle, path_, hits);
}

/** Чтение локального хранилища. Никакой сети и никаких обращений к `raw.json` (инвариант 9). */
export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private docDir(docId: string): string {
    assertDocId(docId);
    return path.join(this.root, docId);
  }

  /**
   * Чтение + разбор + проверка схемой из `src/shared` (T5, codex).
   * Свои сообщения про отсутствующий файл сохраняем: агенту нужен не стек, а следующий шаг.
   */
  private async readJson<T>(
    file: string,
    notFound: string,
    check: (value: unknown, source: string) => T,
  ): Promise<T> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isEnoent(error)) throw new VaultError(notFound);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new VaultError(`Файл повреждён и не разбирается как JSON: ${file}`);
    }
    try {
      return check(parsed, file);
    } catch (error) {
      if (error instanceof VaultValidationError) throw new VaultError(error.message);
      throw error;
    }
  }

  async list(): Promise<VaultIndex> {
    return (await this.readJson(
      path.join(this.root, "index.json"),
      `В ${this.root} нет index.json — vault пуст. Сначала выгрузите макет: npm run pull -- <figma-url>`,
      validateVaultIndex,
    )) as VaultIndex;
  }

  async getRawDoc(docId: string): Promise<VaultDocument> {
    return (await this.readJson(
      path.join(this.docDir(docId), "doc.json"),
      `Документ ${docId} не найден. Список доступных — vault_list.`,
      validateVaultDocument,
    )) as VaultDocument;
  }

  async getDoc(docId: string, maxDepth?: number): Promise<TruncatedDocument> {
    const doc = await this.getRawDoc(docId);
    if (maxDepth === undefined) return doc;
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new VaultError(`maxDepth должен быть целым числом >= 0, получено: ${maxDepth}`);
    }
    const omitted = { count: 0 };
    const root = truncate(doc.root, maxDepth, omitted);
    return { ...doc, root, truncation: { maxDepth, omittedNodes: omitted.count } };
  }

  async getNode(docId: string, nodeId: string): Promise<VaultNode> {
    const doc = await this.getRawDoc(docId);
    const node = findNode(doc.root, nodeId);
    if (!node) {
      throw new VaultError(`Узел ${nodeId} не найден в ${docId}. Поиск по имени — vault_search.`);
    }
    return node;
  }

  async getTokens(docId: string): Promise<VaultTokens> {
    return (await this.getRawDoc(docId)).tokens;
  }

  async search(docId: string, query: string, limit = 50): Promise<SearchResult> {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) throw new VaultError("Пустой query: нечего искать.");
    const doc = await this.getRawDoc(docId);
    const hits: SearchHit[] = [];
    collectHits(doc.root, needle, [], hits);
    return {
      docId,
      query,
      total: hits.length,
      returned: Math.min(hits.length, limit),
      hits: hits.slice(0, limit),
    };
  }

  async getAsset(docId: string, assetPath: string): Promise<AssetPayload> {
    const dir = this.docDir(docId);
    const target = path.resolve(dir, assetPath);
    const relative = path.relative(dir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new VaultError(`Путь выходит за пределы документа: ${assetPath}`);
    }
    const mimeType = ASSET_MIME[path.extname(target).toLowerCase()];
    if (!mimeType) {
      throw new VaultError(
        `Не ресурс изображения: ${assetPath}. Доступны ${Object.keys(ASSET_MIME).join(", ")}.`,
      );
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(target);
    } catch (error) {
      if (isEnoent(error)) {
        throw new VaultError(`Ресурс ${assetPath} не найден в ${docId}.`);
      }
      throw error;
    }
    const encoding = mimeType === "image/svg+xml" ? "utf8" : "base64";
    return {
      path: relative.split(path.sep).join("/"),
      mimeType,
      bytes: buffer.byteLength,
      data: buffer.toString(encoding),
      encoding,
    };
  }
}
