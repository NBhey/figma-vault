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
  if (before === JSON.stringify(entry)) return "запись уже настроена";

  servers[MCP_SERVER_NAME] = entry;
  const next: McpConfig = { ...existing, mcpServers: servers };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return before === undefined ? "запись добавлена" : "запись обновлена";
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
description: Выгрузить макет Figma и сверстать его
argument-hint: <ссылка на фрейм Figma>
allowed-tools: Bash(npx figma-vault:*), Read, Write, Edit, Glob, Grep
---

Свёрстай интерфейс по макету Figma: $ARGUMENTS

Порядок работы:

1. Выгрузи макет в локальное хранилище одной командой:
   \`npx figma-vault add "$ARGUMENTS" --vault ${vaultDir}\`
   Если команда сообщает, что нет FIGMA_TOKEN — скажи об этом и остановись.

2. Прочитай макет через MCP-сервер \`figma-vault\`, а НЕ через Figma:
   - \`vault_list\` — найди docId только что выгруженного макета;
   - \`vault_get_doc\` с небольшим maxDepth — пойми структуру;
   - \`vault_get_node\` — углубляйся в нужные секции;
   - \`vault_get_tokens\` — цвета и типографика, если они есть.

3. Важные особенности данных:
   - порядок \`children\` — это z-order Figma, а не визуальный. Реальный порядок
     секций сверху вниз даёт сортировка по \`layout.y\`;
   - \`layout.mode: row|column\` — это auto-layout, верстай флексом с указанными
     \`gap\` и \`padding\`. При \`mode: none\` используй \`x/y/w/h\` относительно родителя;
   - ассеты из \`node.asset.path\` лежат в каталоге макета в хранилище, бери их оттуда;
   - в \`tokens\` могут быть имена с префиксом \`inferred/\` — это не общие стили из Figma,
     а повторяющиеся значения, выведенные при выгрузке. Опирайся на них как на палитру:
     заводи переменные вместо того, чтобы хардкодить цвет в каждом правиле, но давай им
     осмысленные имена по смыслу использования, а не \`inferred/color/11d452\`;
   - \`text.runs\` — куски текста со своим цветом или жирностью внутри одного узла;
   - скрытые в Figma узлы по умолчанию не отдаются, \`hiddenOmitted\` у узла говорит,
     сколько их. Если верстаешь переиспользуемый компонент со слотами — запроси их
     с \`includeHidden: true\`.

4.Свёрстай, следуя конвенциям этого проекта: посмотри на соседние компоненты и
   повтори их стиль, именование и способ работы со стилями. Не тащи новые зависимости.

5. Проверь вёрстку по макету, если в проекте есть чем открыть страницу в браузере
   (Playwright, dev-сервер и браузерный инструмент). Иначе пропусти шаг и скажи об этом.
   - Пометь корневой элемент вёрстки \`data-figma-node-id="<id корня макета>"\`, а крупные
     блоки — id их узлов. Если в проекте такие атрибуты не приняты, убери их после проверки.
   - \`npx figma-vault verify <docId> --snippet --vault ${vaultDir}\` печатает скрипт.
     Выполни его на свёрстанной странице и сохрани результат в файл.
   - \`npx figma-vault verify <docId> --snapshot <файл> --vault ${vaultDir}\`.
     FAIL — исправь перечисленное и проверь снова. INCOMPLETE — не хватает разметки.

6. В конце коротко перечисли, что не удалось восстановить из данных и что не прошло
   проверку. Известный пробел формата: у кусков текста сохраняются только цвет и жирность.
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
  out(`Хранилище: ${vault}`);
  out("В рабочем репозитории не создано ни одного файла.");
  out("");
  out("Осталось два шага, оба вне проекта.");
  out("");
  out("1. Токен — в переменную окружения пользователя, не в файл проекта:");
  out("     setx FIGMA_TOKEN \"figd_...\"            (Windows, новый терминал после)");
  out("     export FIGMA_TOKEN=figd_...             (macOS/Linux, в ~/.zshrc или ~/.bashrc)");
  out("   Нужен только тому, кто выгружает макеты.");
  out("");
  out("2. Зарегистрировать сервер в пользовательском конфиге агента:");
  out("");
  out("   Claude Code:");
  out(`     claude mcp add --scope user figma-vault -- npx -y figma-vault mcp --vault "${vault}"`);
  out("");
  out("   Codex — в ~/.codex/config.toml:");
  out("     [mcp_servers.figma-vault]");
  out('     command = "npx"');
  out(`     args = ["-y", "figma-vault", "mcp", "--vault", ${JSON.stringify(vault)}]`);
  out("");
  out("Дальше из любого каталога:");
  out(`  figma-vault add "<ссылка на фрейм>" --vault "${vault}"`);
  out(`  figma-vault check --vault "${vault}"`);
}

export interface InitOptions {
  noCommand?: boolean;
}

export async function runInit(cwd: string, vaultDir: string, options: InitOptions = {}): Promise<void> {
  const out = (line: string) => process.stdout.write(`${line}\n`);

  await mkdir(path.join(cwd, vaultDir), { recursive: true });
  out(`Хранилище:      ${vaultDir}/`);

  const mcpState = await writeMcpConfig(cwd, vaultDir);
  out(`.mcp.json:      ${mcpState} (сервер ${MCP_SERVER_NAME})`);

  const added = await ensureGitignore(cwd, [".env"]);
  out(`.gitignore:     ${added.length > 0 ? `добавлено ${added.join(", ")}` : "менять не потребовалось"}`);

  const envExample = path.join(cwd, ".env.example");
  if (!(await exists(envExample))) {
    await writeFile(envExample, "FIGMA_TOKEN=\n", "utf8");
    out(".env.example:   создан");
  } else {
    out(".env.example:   уже есть");
  }

  if (options.noCommand) {
    out(".claude/commands/figma.md: пропущено (--no-command)");
  } else {
    const commandFile = path.join(cwd, ".claude", "commands", "figma.md");
    await mkdir(path.dirname(commandFile), { recursive: true });
    await writeFile(commandFile, SLASH_COMMAND(vaultDir), "utf8");
    out(".claude/commands/figma.md: создан");
  }

  out("");
  out("Дальше:");
  out("  1. Положите Figma-токен в .env строкой FIGMA_TOKEN=figd_...");
  out("     (нужен только тому, кто выгружает макеты)");
  out('  2. npx figma-vault add "<ссылка на фрейм>"');
  out(`  3. Закоммитьте ${vaultDir}/ — тогда команде токен не нужен вообще`);
  out("  4. В Claude Code: /figma <ссылка на фрейм>");
  out("");
  out("Codex и другие агенты берут тот же сервер из .mcp.json.");
}
