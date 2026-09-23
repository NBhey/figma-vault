import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { VaultNode } from "../mcp/types.js";
import { runVerify, VERIFY_EXIT } from "./verify.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vaultDir = path.join(repoRoot, "vault", "example");
const doc = JSON.parse(
  await readFile(path.join(vaultDir, "EXAMPLE1234_1_1", "doc.json"), "utf8"),
) as { root: VaultNode };

/** Снимок идеальной вёрстки: все тексты, корень и блоки первого уровня на своих местах. */
function perfectSnapshot(marked: boolean) {
  const texts: string[] = [];
  const collect = (node: VaultNode) => {
    if (node.text) texts.push(node.text.content);
    node.children?.forEach(collect);
  };
  collect(doc.root);
  const { w, h } = doc.root.layout;
  const nodes = marked
    ? [
        { id: doc.root.id, x: 0, y: 0, w, h },
        ...(doc.root.children ?? []).map((child) => ({ id: child.id, ...child.layout })),
      ]
    : [];
  return { schema: "figma-vault/snapshot@0", root: marked ? doc.root.id : null, viewport: { w, h }, texts, nodes };
}

async function verifyWith(snapshot: unknown, encodeTwice = false): Promise<{ code: number; output: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-verify-"));
  const file = path.join(dir, "snapshot.json");
  const json = JSON.stringify(snapshot);
  await writeFile(file, encodeTwice ? JSON.stringify(json) : json);
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => ((output += chunk), true)) as typeof process.stdout.write;
  try {
    const code = await runVerify(undefined, { vaultDir, snippet: false, snapshotFile: file });
    return { code, output };
  } finally {
    process.stdout.write = write;
    await rm(dir, { recursive: true, force: true });
  }
}

test("verify: совпадающая вёрстка — PASS и код 0, docId берётся единственный из хранилища", async () => {
  const { code, output } = await verifyWith(perfectSnapshot(true));
  assert.equal(code, VERIFY_EXIT.PASS, output);
  assert.match(output, /^PASS/m);
});

test("verify: пропавший текст и сдвинутый блок — FAIL и код 1 с перечнем", async () => {
  const snapshot = perfectSnapshot(true);
  snapshot.texts = snapshot.texts.filter((text) => text !== "или");
  const moved = snapshot.nodes[1];
  if (moved) moved.x += 10;
  const { code, output } = await verifyWith(snapshot);
  assert.equal(code, VERIFY_EXIT.FAIL);
  assert.match(output, /нет: "или"/);
  assert.match(output, /x в макете \d+, в вёрстке \d+ \(разница 10\)/);
});

test("verify: без разметки data-figma-node-id — INCOMPLETE и код 2, а не ложный PASS", async () => {
  const { code, output } = await verifyWith(perfectSnapshot(false));
  assert.equal(code, VERIFY_EXIT.INCOMPLETE);
  assert.match(output, /Пометьте корень вёрстки/);
});

test("verify: корень уже кадра на ширину полосы прокрутки — подсказка переснять, а не загадка", async () => {
  const snapshot = { ...perfectSnapshot(true), scrollbar: 15 };
  const root = snapshot.nodes[0];
  if (root) root.w -= 15;
  const { code, output } = await verifyWith(snapshot);
  assert.equal(code, VERIFY_EXIT.FAIL, "расхождение остаётся расхождением");
  assert.match(output, /15 px окна заняла полоса прокрутки/);
  assert.match(output, new RegExp(`ширине окна ${doc.root.layout.w + 15} px`));
});

test("verify: снимок, сохранённый как строка JSON внутри JSON, тоже читается", async () => {
  const { code } = await verifyWith(perfectSnapshot(true), true);
  assert.equal(code, VERIFY_EXIT.PASS);
});
