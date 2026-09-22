import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { Vault, VaultError } from "./vault.js";

export const SERVER_NAME = "figma-vault";
export const SERVER_VERSION = "0.1.0";

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Любая ошибка внутри инструмента возвращается агенту текстом, а не роняет сервер. */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof VaultError) return failure(error);
    return failure(error instanceof Error ? `Внутренняя ошибка: ${error.message}` : error);
  }
}

const docIdArg = z.string().min(1).describe("Идентификатор документа из vault_list");

export function createServer(vault: Vault): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Локальное хранилище макетов Figma. Начинайте с vault_list, затем vault_get_doc " +
        "с небольшим maxDepth, чтобы увидеть структуру, и углубляйтесь через vault_get_node. " +
        "Координаты x/y относительны родителю; при layout.mode=row|column это auto-layout " +
        "(flex), при mode=none — абсолютное позиционирование по x/y/w/h.",
    },
  );

  server.registerTool(
    "vault_list",
    {
      title: "Список макетов",
      description: "Все выгруженные документы: docId, имя файла и узла, время выгрузки, число узлов.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => json(await vault.list())),
  );

  server.registerTool(
    "vault_get_doc",
    {
      title: "Документ целиком",
      description:
        "Нормализованное дерево макета вместе с токенами. maxDepth обрезает дерево по глубине " +
        "(0 — только корень); у обрезанных узлов появляется childrenOmitted.",
      inputSchema: {
        docId: docIdArg,
        maxDepth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Сколько уровней ниже корня отдавать. Без параметра — всё дерево."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ docId, maxDepth }) => guard(async () => json(await vault.getDoc(docId, maxDepth))),
  );

  server.registerTool(
    "vault_get_node",
    {
      title: "Поддерево узла",
      description: "Узел по id со всеми потомками. Нужен, чтобы не тянуть весь документ.",
      inputSchema: {
        docId: docIdArg,
        nodeId: z.string().min(1).describe("id узла в формате Figma, например 1:42"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ docId, nodeId }) => guard(async () => json(await vault.getNode(docId, nodeId))),
  );

  server.registerTool(
    "vault_search",
    {
      title: "Поиск по макету",
      description:
        "Узлы, у которых имя или текстовое содержимое содержит подстроку (без учёта регистра). " +
        "Возвращает id, тип и путь от корня.",
      inputSchema: {
        docId: docIdArg,
        query: z.string().min(1).describe("Подстрока для поиска в name и text.content"),
        limit: z.number().int().min(1).max(500).optional().describe("Максимум совпадений, по умолчанию 50"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ docId, query, limit }) =>
      guard(async () => json(await vault.search(docId, query, limit))),
  );

  server.registerTool(
    "vault_get_tokens",
    {
      title: "Токены дизайн-системы",
      description: "Цвета, текстовые стили и эффекты документа. Узлы ссылаются на них через text.token.",
      inputSchema: { docId: docIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ docId }) => guard(async () => json(await vault.getTokens(docId))),
  );

  server.registerTool(
    "vault_get_asset",
    {
      title: "Ресурс макета",
      description:
        "Картинка из документа по пути из node.asset.path (например assets/logo.svg) " +
        "или screenshot.png. Растр отдаётся картинкой, svg — исходником.",
      inputSchema: {
        docId: docIdArg,
        path: z.string().min(1).describe("Путь внутри каталога документа, например assets/hero.png"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ docId, path: assetPath }) =>
      guard(async () => {
        const asset = await vault.getAsset(docId, assetPath);
        if (asset.encoding === "utf8") {
          return { content: [{ type: "text", text: asset.data }] };
        }
        return { content: [{ type: "image", data: asset.data, mimeType: asset.mimeType }] };
      }),
  );

  return server;
}
