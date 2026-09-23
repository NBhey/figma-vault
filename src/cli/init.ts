import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Команда MCP-сервера в конфиге проекта: работает и при локальной установке, и через npx. */
const MCP_SERVER_NAME = "figma-vault";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Регистрирует сервер в .mcp.json, не затирая чужие записи. */
async function writeMcpConfig(cwd: string, vaultDir: string): Promise<string> {
  const file = path.join(cwd, ".mcp.json");
  const existing = (await readJson<McpConfig>(file)) ?? {};
  const servers = { ...(existing.mcpServers ?? {}) };

  const entry = {
    type: "stdio",
    command: "npx",
    args: ["-y", "figma-vault", "mcp", "--vault", vaultDir],
    env: {},
  };

  const before = JSON.stringify(servers[MCP_SERVER_NAME]);
  if (before === JSON.stringify(entry)) return "entry already configured";

  servers[MCP_SERVER_NAME] = entry;
  const next: McpConfig = { ...existing, mcpServers: servers };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return before === undefined ? "entry added" : "entry updated";
}

/** Дописывает строки в .gitignore, если их там ещё нет. */
async function ensureGitignore(cwd: string, lines: string[]): Promise<string[]> {
  const file = path.join(cwd, ".gitignore");
  const current = (await exists(file)) ? await readFile(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l));
  if (missing.length === 0) return [];
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
  return missing;
}

const SLASH_COMMAND = (vaultDir: string) => `---
description: Export a Figma design and build it
argument-hint: <link to a Figma frame>
allowed-tools: Bash(npx figma-vault:*), Read, Write, Edit, Glob, Grep
---

Build the interface from this Figma design: $ARGUMENTS

How to work:

1. Export the design into the local vault with one command:
   \`npx figma-vault add "$ARGUMENTS" --vault ${vaultDir}\`
   If the command reports that FIGMA_TOKEN is missing — say so and stop.

2. Read the design through the \`figma-vault\` MCP server, NOT through Figma:
   - \`vault_list\` — find the docId of the design you have just exported;
   - \`vault_get_doc\` with a small maxDepth — understand the structure;
   - \`vault_get_node\` — go deeper into the sections you need;
   - \`vault_get_tokens\` — colors and typography, if there are any.

3. Important traits of the data:
   - the order of \`children\` is Figma's z-order, not the visual one. The real
     top-to-bottom order of sections comes from sorting by \`layout.y\`;
   - \`layout.mode: row|column\` means auto-layout — build it with flex using the given
     \`gap\` and \`padding\`. With \`mode: none\` use \`x/y/w/h\` relative to the parent;
   - assets from \`node.asset.path\` lie in the design directory inside the vault, take them from there;
   - \`tokens\` may hold names prefixed with \`inferred/\` — those are not shared styles from Figma
     but repeated values derived during the export. Lean on them as a palette: declare variables
     instead of hardcoding a color in every rule, but give them meaningful names after how they
     are used, not \`inferred/color/11d452\`;
   - \`text.runs\` are pieces of text with their own color or weight inside a single node;
   - nodes hidden in Figma are not returned by default, \`hiddenOmitted\` on a node tells how many
     there are. If you are building a reusable component with slots — request them
     with \`includeHidden: true\`.

4. Build it following the conventions of this project: look at neighbouring components and
   repeat their style, naming and way of working with styles. Do not pull in new dependencies.

5. Check the layout against the design if the project has a way to open the page in a browser
   (Playwright, a dev server and a browser tool). Otherwise skip this step and say so.
   - Mark the root element of the layout with \`data-figma-node-id="<id of the design root>"\`, and
     large blocks with the ids of their nodes. If such attributes are not customary in the project,
     remove them after the check.
   - \`npx figma-vault verify <docId> --snippet --vault ${vaultDir}\` prints a script.
     Run it on the built page and save the result into a file.
   - \`npx figma-vault verify <docId> --snapshot <file> --vault ${vaultDir}\`.
     FAIL — fix what is listed and check again. INCOMPLETE — the markup is not enough.

6. At the end, briefly list what could not be restored from the data and what did not pass
   the check. A known gap of the format: text pieces keep only color and weight.
`;

/**
 * Режим без следа в репозитории: хранилище в домашнем каталоге, сервер — в пользовательском
 * конфиге агента. Рабочий проект о существовании инструмента не узнаёт.
 * Конфиг агента не правим сами: это чужой файл с состоянием, ломать его нельзя.
 */
export async function runInitGlobal(vaultDirArg: string): Promise<void> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const vault =
    vaultDirArg === ".figma-vault" ? path.join(home, ".figma-vault") : path.resolve(vaultDirArg);

  await mkdir(vault, { recursive: true });
  out(`Vault: ${vault}`);
  out("Not a single file has been created in the working repository.");
  out("");
  out("Two steps left, both outside the project.");
  out("");
  out("1. The token goes into a user environment variable, not into a project file:");
  out("     setx FIGMA_TOKEN \"figd_...\"            (Windows, open a new terminal afterwards)");
  out("     export FIGMA_TOKEN=figd_...             (macOS/Linux, in ~/.zshrc or ~/.bashrc)");
  out("   Only whoever exports designs needs it.");
  out("");
  out("2. Register the server in the user config of your agent:");
  out("");
  out("   Claude Code:");
  out(`     claude mcp add --scope user figma-vault -- npx -y figma-vault mcp --vault "${vault}"`);
  out("");
  out("   Codex — in ~/.codex/config.toml:");
  out("     [mcp_servers.figma-vault]");
  out('     command = "npx"');
  out(`     args = ["-y", "figma-vault", "mcp", "--vault", ${JSON.stringify(vault)}]`);
  out("");
  out("Then, from any directory:");
  out(`  figma-vault add "<link to a frame>" --vault "${vault}"`);
  out(`  figma-vault check --vault "${vault}"`);
}

export interface InitOptions {
  noCommand?: boolean;
}

export async function runInit(cwd: string, vaultDir: string, options: InitOptions = {}): Promise<void> {
  const out = (line: string) => process.stdout.write(`${line}\n`);

  await mkdir(path.join(cwd, vaultDir), { recursive: true });
  out(`Vault:          ${vaultDir}/`);

  const mcpState = await writeMcpConfig(cwd, vaultDir);
  out(`.mcp.json:      ${mcpState} (server ${MCP_SERVER_NAME})`);

  const added = await ensureGitignore(cwd, [".env"]);
  out(`.gitignore:     ${added.length > 0 ? `added ${added.join(", ")}` : "no change needed"}`);

  const envExample = path.join(cwd, ".env.example");
  if (!(await exists(envExample))) {
    await writeFile(envExample, "FIGMA_TOKEN=\n", "utf8");
    out(".env.example:   created");
  } else {
    out(".env.example:   already there");
  }

  if (options.noCommand) {
    out(".claude/commands/figma.md: skipped (--no-command)");
  } else {
    const commandFile = path.join(cwd, ".claude", "commands", "figma.md");
    await mkdir(path.dirname(commandFile), { recursive: true });
    await writeFile(commandFile, SLASH_COMMAND(vaultDir), "utf8");
    out(".claude/commands/figma.md: created");
  }

  out("");
  out("Next:");
  out("  1. Put the Figma token into .env as FIGMA_TOKEN=figd_...");
  out("     (only whoever exports designs needs it)");
  out('  2. npx figma-vault add "<link to a frame>"');
  out(`  3. Commit ${vaultDir}/ — then the team needs no token at all`);
  out("  4. In Claude Code: /figma <link to a frame>");
  out("");
  out("Codex and other agents pick up the same server from .mcp.json.");
}
