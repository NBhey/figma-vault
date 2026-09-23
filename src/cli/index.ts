#!/usr/bin/env node

import { runAdd } from "./add.js";
import { runCheck } from "./check.js";
import { runDemo } from "./demo.js";
import { runInit, runInitGlobal } from "./init.js";
import { runLimits } from "./limits.js";
import { runVerify } from "./verify.js";

const USAGE = `figma-vault — local storage of Figma designs for AI agents

  figma-vault init                 connect the vault to the current project
  figma-vault init --global        the same, but without a single file in the project repo
  figma-vault add <figma-url>      export a design into the vault
  figma-vault demo                 put the demo design into the vault (no token needed)
  figma-vault limits <figma-url>   check Figma rate limits before exporting (2 requests)
  figma-vault check                check that the whole chain works
  figma-vault list                 what is already exported
  figma-vault verify [docId] --snippet
                                   browser script: takes a snapshot of the built page
  figma-vault verify [docId] --snapshot <file>
                                   compare the snapshot with the design: texts and marked blocks
  figma-vault mcp                  start the MCP server (called by an agent, not by a human)

Options:
  --no-assets                      structure only, no images (the render limit is stricter)
  --no-command                     init: do not install the /figma slash command
  --vault <directory>              .figma-vault by default
  --tolerance <px>                 verify: geometry tolerance, 2 by default

Token: FIGMA_TOKEN in .env or in the environment.
Only whoever exports a design needs it; everyone else does not.`;

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
      if (!value) throw new Error("--vault needs a directory path");
      vaultDir = value;
    } else if (arg === "--snippet") {
      snippet = true;
    } else if (arg === "--snapshot") {
      snapshotFile = args.shift();
      if (!snapshotFile) throw new Error("--snapshot needs a path to the snapshot file");
    } else if (arg === "--tolerance") {
      tolerance = Number(args.shift());
      if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("--tolerance needs a number of pixels >= 0");
    } else if (arg === "--no-command") {
      noCommand = true;
    } else if (arg === "--global") {
      globalMode = true;
    } else if (arg === "--no-assets") {
      noAssets = true;
    } else if (arg === "--help" || arg === "-h") {
      positional.push("--help");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
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
      `Vault ${vaultDir} is empty.\nExport a design: figma-vault add "<link to a frame>"\n`,
    );
    return;
  }
  process.stdout.write(`Vault ${vaultDir}, designs: ${index.docs.length}\n\n`);
  for (const doc of index.docs) {
    process.stdout.write(`  ${doc.docId}\n`);
    process.stdout.write(`    ${doc.fileName} → ${doc.nodeName}\n`);
    process.stdout.write(`    nodes: ${doc.nodeCount}, exported: ${doc.exportedAt}\n\n`);
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
  process.stderr.write(`[figma-vault] MCP on stdio, vault: ${vaultDir}\n`);
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
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
