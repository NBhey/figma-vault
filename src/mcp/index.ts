#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { Vault } from "./vault.js";

/** stdout занят протоколом MCP — любой человекочитаемый вывод идёт в stderr. */
function note(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

export function resolveVaultDir(argv: string[], env: NodeJS.ProcessEnv): string {
  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--vault") {
      const value = args.shift();
      if (!value) throw new Error("Usage: npm run mcp -- [--vault <directory>]");
      return value;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return env.FIGMA_VAULT_DIR ?? "vault";
}

async function main(): Promise<void> {
  const vault = new Vault(resolveVaultDir(process.argv.slice(2), process.env));
  const server = createServer(vault);
  await server.connect(new StdioServerTransport());
  note(`v${SERVER_VERSION} on stdio, vault: ${vault.root}`);
}

const entry = process.argv[1];

if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    note(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { createServer } from "./server.js";
export { Vault, VaultError } from "./vault.js";
export type { VaultDocument, VaultIndex, VaultNode, VaultTokens } from "./types.js";
