#!/usr/bin/env node

import { runAdd } from "./add.js";
import { runCheck } from "./check.js";
import { runDemo } from "./demo.js";
import { runInit, runInitGlobal } from "./init.js";
import { runLimits } from "./limits.js";
import { runVerify } from "./verify.js";

const USAGE = `figma-vault — локальное хранилище макетов Figma для AI-агентов

  figma-vault init                 подключить хранилище к текущему проекту
  figma-vault init --global        то же, но без единого файла в репозитории проекта
  figma-vault add <figma-url>      выгрузить макет в хранилище
  figma-vault demo                 положить демо-макет в хранилище (без токена)
  figma-vault limits <figma-url>   проверить лимиты Figma до выгрузки (2 запроса)
  figma-vault check                проверить, что вся цепочка работает
  figma-vault list                 что уже выгружено
  figma-vault verify [docId] --snippet
                                   скрипт для браузера: снимает снимок свёрстанной страницы
  figma-vault verify [docId] --snapshot <файл>
                                   сверить снимок с макетом: тексты и размеченные блоки
  figma-vault mcp                  запустить MCP-сервер (вызывает агент, не человек)

Опции:
  --no-assets                      только структура, без картинок (лимит рендера строже)
  --no-command                     init: не ставить слэш-команду /figma
  --vault <каталог>                по умолчанию .figma-vault
  --tolerance <px>                 verify: допуск по геометрии, по умолчанию 2

Токен: FIGMA_TOKEN в .env или в переменных окружения.
Нужен только тому, кто выгружает макет; остальным — нет.`;

const DEFAULT_VAULT = ".figma-vault";

interface ParsedArgs {
  command: string;
  positional: string[];
  vaultDir: string;
  noAssets: boolean;
  globalMode: boolean;
  noCommand: boolean;
  snippet: boolean;
  snapshotFile?: string;
  tolerance?: number;
}

/** Ссылку на макет принимаем и без подкоманды: `figma-vault <figma-url>` == `add <figma-url>`. */
function looksLikeFigmaUrl(value: string): boolean {
  return /^https?:\/\/(www\.)?figma\.com\//i.test(value);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const first = args.shift();
  const command = first === undefined ? "help" : looksLikeFigmaUrl(first) ? "add" : first;
  const positional: string[] = [];
  if (first !== undefined && command === "add" && looksLikeFigmaUrl(first)) positional.push(first);
  let vaultDir = process.env.FIGMA_VAULT_DIR ?? DEFAULT_VAULT;
  let noAssets = false;
  let globalMode = false;
  let noCommand = false;
  let snippet = false;
  let snapshotFile: string | undefined;
  let tolerance: number | undefined;

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--vault") {
      const value = args.shift();
      if (!value) throw new Error("--vault требует путь к каталогу");
      vaultDir = value;
    } else if (arg === "--snippet") {
      snippet = true;
    } else if (arg === "--snapshot") {
      snapshotFile = args.shift();
      if (!snapshotFile) throw new Error("--snapshot требует путь к файлу снимка");
    } else if (arg === "--tolerance") {
      tolerance = Number(args.shift());
      if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("--tolerance требует число пикселей >= 0");
    } else if (arg === "--no-command") {
      noCommand = true;
    } else if (arg === "--global") {
      globalMode = true;
    } else if (arg === "--no-assets") {
      noAssets = true;
    } else if (arg === "--help" || arg === "-h") {
      positional.push("--help");
    } else if (arg.startsWith("--")) {
      throw new Error(`Неизвестная опция: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, vaultDir, noAssets, globalMode, noCommand, snippet, snapshotFile, tolerance };
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

/**
 * `.env` текущего каталога. `npm run cli` подгружает его флагом node, а у установленного
 * бинаря такого флага нет — без этой функции токен из `.env` не виден.
 * Уже заданные переменные окружения `.env` не перекрывает.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const { command, positional, vaultDir, noAssets, globalMode, noCommand, snippet, snapshotFile, tolerance } =
    parseArgs(process.argv.slice(2));

  if (positional.includes("--help") || command === "help" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (command) {
    case "init":
      await (globalMode ? runInitGlobal(vaultDir) : runInit(process.cwd(), vaultDir, { noCommand }));
      return;
    case "add":
    case "pull":
      await runAdd(positional[0], { vaultDir, noAssets });
      return;
    case "demo":
      await runDemo(process.cwd(), vaultDir);
      return;
    case "limits":
      await runLimits(positional[0]);
      return;
    case "check":
      await runCheck(process.cwd(), vaultDir, process.argv[1] as string);
      return;
    case "list":
      await list(vaultDir);
      return;
    case "verify":
      process.exitCode = await runVerify(positional[0], { vaultDir, snippet, snapshotFile, tolerance });
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
