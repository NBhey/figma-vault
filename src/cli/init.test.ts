import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runInit, runInitGlobal } from "./init.js";

/**
 * `init` печатает в stdout и пишет файлы: и то, и другое видит англоязычный пользователь.
 * Путь временного каталога из вывода вырезается: в имени пользователя ОС бывает кириллица,
 * и она не имеет отношения к языку интерфейса.
 */
async function inTempDir<T>(run: (dir: string) => Promise<T>): Promise<{ result: T; output: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-init-"));
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => ((output += chunk), true)) as typeof process.stdout.write;
  try {
    const result = await run(dir);
    return { result, output: output.split(dir).join("<tmp>") };
  } finally {
    process.stdout.write = write;
    await rm(dir, { recursive: true, force: true });
  }
}

test("init: вывод и созданные файлы английские, .mcp.json и /figma на месте", async () => {
  const { output } = await inTempDir(async (dir) => {
    await runInit(dir, ".figma-vault");

    const config = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    // Имя сервера, команда и аргументы — это контракт с конфигом агента, перевод их не трогает.
    assert.deepEqual(config.mcpServers["figma-vault"]?.args, [
      "-y",
      "figma-vault",
      "mcp",
      "--vault",
      ".figma-vault",
    ]);

    const command = await readFile(path.join(dir, ".claude", "commands", "figma.md"), "utf8");
    assert.doesNotMatch(command, /[А-Яа-я]/, command);
    assert.match(command, /^description: Export a Figma design and build it$/m);
    assert.match(command, /^argument-hint: <link to a Figma frame>$/m);
    // Имена инструментов и вердиктов остаются как есть: их сверяет не человек, а код.
    for (const literal of ["vault_get_doc", "includeHidden: true", "FAIL", "INCOMPLETE"]) {
      assert.ok(command.includes(literal), `в шаблоне /figma нет ${literal}`);
    }
  });

  assert.doesNotMatch(output, /[А-Яа-я]/, output);
  assert.match(output, /^Vault: {10}\.figma-vault\/$/m);
  assert.match(output, /\.mcp\.json: {6}entry added \(server figma-vault\)/);
  assert.match(output, /\.claude\/commands\/figma\.md: created/);
});

test("init --no-command: слэш-команда не ставится, причина сказана по-английски", async () => {
  const { output } = await inTempDir(async (dir) => {
    await runInit(dir, ".figma-vault", { noCommand: true });
    await assert.rejects(() => readFile(path.join(dir, ".claude", "commands", "figma.md"), "utf8"));
  });
  assert.match(output, /\.claude\/commands\/figma\.md: skipped \(--no-command\)/);
});

test("init --global: инструкция по настройке вне проекта английская", async () => {
  const { output } = await inTempDir(async (dir) => {
    await runInitGlobal(path.join(dir, "vault"));
  });
  assert.doesNotMatch(output, /[А-Яа-я]/, output);
  assert.match(output, /claude mcp add --scope user figma-vault/);
  assert.match(output, /Only whoever exports designs needs it\./);
});
