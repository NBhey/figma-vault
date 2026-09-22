#!/usr/bin/env node

import { pullFigmaSelection } from "../pull/pull.js";
import { runCheck } from "./check.js";
import { runDemo } from "./demo.js";
import { runInit } from "./init.js";

const USAGE = `figma-vault — локальное хранилище макетов Figma для AI-агентов

  figma-vault init                 подключить хранилище к текущему проекту
  figma-vault add <figma-url>      выгрузить макет в хранилище
  figma-vault demo                 положить демо-макет в хранилище (без токена)
  figma-vault check                проверить, что вся цепочка работает
  figma-vault list                 что уже выгружено
  figma-vault mcp                  запустить MCP-сервер (вызывает агент, не человек)

Опции add/list/mcp:
  --vault <каталог>                по умолчанию .figma-vault

Токен: FIGMA_TOKEN в .env или в переменных окружения.
Нужен только тому, кто выгружает макет; остальным — нет.`;

const DEFAULT_VAULT = ".figma-vault";

interface ParsedArgs {
  command: string;
  positional: string[];
  vaultDir: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const positional: string[] = [];
  let vaultDir = process.env.FIGMA_VAULT_DIR ?? DEFAULT_VAULT;

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--vault") {
      const value = args.shift();
      if (!value) throw new Error("--vault требует путь к каталогу");
      vaultDir = value;
    } else if (arg === "--help" || arg === "-h") {
      positional.push("--help");
    } else if (arg.startsWith("--")) {
      throw new Error(`Неизвестная опция: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, vaultDir };
}

async function add(figmaUrl: string | undefined, vaultDir: string): Promise<void> {
  if (!figmaUrl) {
    throw new Error(
      "Нужна ссылка на фрейм: figma-vault add \"https://figma.com/design/...?node-id=1-42\"\n" +
        "В Figma: правая кнопка по фрейму → Copy link to selection.",
    );
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      "Не задан FIGMA_TOKEN.\n" +
        "Figma → Settings → Security → Personal access tokens → Generate new token,\n" +
        "scope: File content (read-only). Положите его в .env строкой FIGMA_TOKEN=figd_...",
    );
  }

  process.stderr.write("Обращаюсь к Figma…\n");
  const result = await pullFigmaSelection(figmaUrl, { token, vaultDir });

  process.stdout.write(`\nГотово: ${result.docId}\n`);
  process.stdout.write(`  узлов:    ${result.nodeCount}\n`);
  process.stdout.write(`  каталог:  ${result.directory}\n`);
  for (const warning of result.warnings ?? []) {
    process.stdout.write(`  внимание: ${warning}\n`);
  }
  process.stdout.write(
    "\nМакет в хранилище. Агент прочитает его через MCP без обращений к Figma.\n" +
      "Закоммитьте каталог хранилища — тогда команде не нужен токен.\n",
  );
}

async function list(vaultDir: string): Promise<void> {
  const { Vault } = await import("../mcp/vault.js");
  const vault = new Vault(vaultDir);
  const index = await vault.list().catch(() => ({ docs: [] }));
  if (index.docs.length === 0) {
    process.stdout.write(
      `Хранилище ${vaultDir} пусто.\nВыгрузите макет: figma-vault add "<ссылка на фрейм>"\n`,
    );
    return;
  }
  process.stdout.write(`Хранилище ${vaultDir}, макетов: ${index.docs.length}\n\n`);
  for (const doc of index.docs) {
    process.stdout.write(`  ${doc.docId}\n`);
    process.stdout.write(`    ${doc.fileName} → ${doc.nodeName}\n`);
    process.stdout.write(`    узлов: ${doc.nodeCount}, выгружен: ${doc.exportedAt}\n\n`);
  }
}

async function mcp(vaultDir: string): Promise<void> {
  // stdout принадлежит протоколу MCP: ничего в него не пишем.
  const [{ StdioServerTransport }, { createServer }, { Vault }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("../mcp/server.js"),
    import("../mcp/vault.js"),
  ]);
  const server = createServer(new Vault(vaultDir));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[figma-vault] MCP на stdio, хранилище: ${vaultDir}\n`);
}

async function main(): Promise<void> {
  const { command, positional, vaultDir } = parseArgs(process.argv.slice(2));

  if (positional.includes("--help") || command === "help" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (command) {
    case "init":
      await runInit(process.cwd(), vaultDir);
      return;
    case "add":
    case "pull":
      await add(positional[0], vaultDir);
      return;
    case "demo":
      await runDemo(process.cwd(), vaultDir);
      return;
    case "check":
      await runCheck(process.cwd(), vaultDir, process.argv[1] as string);
      return;
    case "list":
      await list(vaultDir);
      return;
    case "mcp":
      await mcp(vaultDir);
      return;
    default:
      throw new Error(`Неизвестная команда: ${command}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
