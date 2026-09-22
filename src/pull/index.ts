#!/usr/bin/env node

import { pullFigmaSelection } from "./pull.js";

function usage(): never {
  throw new Error("Usage: npm run pull -- <figma-url> [--vault <directory>]");
}

function parseArgs(argv: string[]): { figmaUrl: string; vaultDir?: string } {
  const args = [...argv];
  const figmaUrl = args.shift();
  if (!figmaUrl) usage();
  let vaultDir: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--vault") {
      vaultDir = args.shift();
      if (!vaultDir) usage();
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return { figmaUrl, vaultDir };
}

async function main(): Promise<void> {
  const { figmaUrl, vaultDir } = parseArgs(process.argv.slice(2));
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error("Set FIGMA_TOKEN to a Personal Access Token with file_content:read scope");
  }
  const result = await pullFigmaSelection(figmaUrl, { token, vaultDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pull failed: ${message}\n`);
  process.exitCode = 1;
});

export { collectRenderTargets, countVaultNodes, normalizeFigmaResponse } from "./normalize.js";
export { parseFigmaUrl } from "./url.js";
export { pullFigmaSelection } from "./pull.js";
export type { FigmaNodesResponse, VaultDocument, VaultNode } from "./types.js";

