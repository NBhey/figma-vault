import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateVaultDocument, validateVaultIndex } from "../shared/index.js";

type Status = "ok" | "warn" | "fail";

interface Step {
  status: Status;
  title: string;
  detail?: string;
}

const MARK: Record<Status, string> = { ok: " OK ", warn: "WARN", fail: "FAIL" };

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Поднимает MCP-сервер дочерним процессом и проверяет, что он отвечает по протоколу. */
function probeMcp(entry: string, vaultDir: string): Promise<Step> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "mcp", "--vault", vaultDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    const done = (step: Step) => {
      clearTimeout(timer);
      child.kill();
      resolve(step);
    };

    const timer = setTimeout(
      () => done({ status: "fail", title: "MCP server", detail: "no answer within 10 seconds" }),
      10_000,
    );

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (msg.id === 2 && msg.result?.tools) {
            const names = msg.result.tools.map((t) => t.name);
            done({
              status: names.length > 0 ? "ok" : "fail",
              title: "MCP server",
              detail: `tools: ${names.length} (${names.join(", ")})`,
            });
            return;
          }
        } catch {
          // фрагмент строки ещё не дочитан
        }
      }
    });

    child.on("error", (error) =>
      done({ status: "fail", title: "MCP server", detail: error.message }),
    );

    const say = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    say({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "figma-vault-check", version: "1" },
      },
    });
    say({ jsonrpc: "2.0", method: "notifications/initialized" });
    say({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

export async function runCheck(cwd: string, vaultDir: string, entry: string): Promise<void> {
  const steps: Step[] = [];
  const target = path.resolve(cwd, vaultDir);

  // 1. Конфиг агентов
  const mcpConfig = await readJson<{ mcpServers?: Record<string, unknown> }>(
    path.join(cwd, ".mcp.json"),
  );
  steps.push(
    mcpConfig?.mcpServers?.["figma-vault"]
      ? { status: "ok", title: ".mcp.json", detail: "the figma-vault server is registered" }
      : {
          status: "fail",
          title: ".mcp.json",
          detail: "no figma-vault entry — run npx figma-vault init",
        },
  );

  // 2. Хранилище и индекс
  const index = await readJson<{ docs: { docId: string }[] }>(path.join(target, "index.json"));
  if (!index) {
    steps.push({
      status: "fail",
      title: "Vault",
      detail: `${vaultDir}/index.json not found — run npx figma-vault demo`,
    });
  } else {
    try {
      validateVaultIndex(index);
      steps.push({
        status: "ok",
        title: "Vault",
        detail: `${vaultDir}/, designs: ${index.docs.length}`,
      });
    } catch (error) {
      steps.push({
        status: "fail",
        title: "Vault",
        detail: `index.json does not match the contract: ${(error as Error).message}`,
      });
    }

    // 3. Каждый документ — против контракта
    for (const { docId } of index.docs) {
      const doc = await readJson<unknown>(path.join(target, docId, "doc.json"));
      if (!doc) {
        steps.push({ status: "fail", title: `Design ${docId}`, detail: "doc.json is not readable" });
        continue;
      }
      try {
        validateVaultDocument(doc);
        let count = 0;
        (function walk(n: { children?: unknown[] }) {
          count++;
          for (const c of n.children ?? []) walk(c as { children?: unknown[] });
        })((doc as { root: { children?: unknown[] } }).root);
        steps.push({ status: "ok", title: `Design ${docId}`, detail: `nodes: ${count}` });
      } catch (error) {
        steps.push({
          status: "fail",
          title: `Design ${docId}`,
          detail: `does not match the contract: ${(error as Error).message}`,
        });
      }
    }
  }

  // 4. Живой MCP-сервер
  steps.push(await probeMcp(entry, target));

  // 5. Токен — не ошибка, а справка
  steps.push(
    process.env.FIGMA_TOKEN
      ? { status: "ok", title: "FIGMA_TOKEN", detail: "set, exporting new designs is available" }
      : {
          status: "warn",
          title: "FIGMA_TOKEN",
          detail: "not set — reading designs from the vault works, exporting new ones does not",
        },
  );

  const out = (line: string) => process.stdout.write(`${line}\n`);
  out("");
  for (const step of steps) {
    out(`[${MARK[step.status]}] ${step.title}${step.detail ? ` — ${step.detail}` : ""}`);
  }

  const failed = steps.filter((s) => s.status === "fail");
  out("");
  if (failed.length === 0) {
    out("The chain works: an agent will read the designs from the vault without calling Figma.");
  } else {
    out(`Problems: ${failed.length}. See the FAIL lines above.`);
    process.exitCode = 1;
  }
}
