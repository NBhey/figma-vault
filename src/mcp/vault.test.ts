import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { validateVaultDocument, validateVaultIndex } from "../shared/index.js";
import { resolveVaultDir } from "./index.js";
import { Vault, VaultError } from "./vault.js";
import type { VaultNode } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vault = new Vault(path.join(repoRoot, "vault", "example"));
const DOC = "EXAMPLE1234_1_1";

function countNodes(node: VaultNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

test("vault_list отдаёт index.json, согласованный с doc.json", async () => {
  const index = await vault.list();
  assert.equal(index.schema, "figma-vault/index@0");
  const entry = index.docs.find((item) => item.docId === DOC);
  assert.ok(entry, "фикстура должна быть в индексе");
  const doc = await vault.getDoc(DOC);
  assert.equal(entry.nodeCount, countNodes(doc.root));
  assert.equal(entry.nodeId, doc.source.nodeId);
  assert.equal(entry.fileKey, doc.source.fileKey);
});

test("фикстура соблюдает инварианты контракта", async () => {
  const doc = await vault.getDoc(DOC);
  assert.equal(doc.schema, "figma-vault/doc@0");
  const seen = new Set<string>();
  const types = new Set(["frame", "text", "image", "vector", "group", "instance"]);

  const walk = (node: VaultNode, parent?: VaultNode): void => {
    assert.ok(node.id && node.name && node.type && node.layout, `узел ${node.id} неполон`);
    assert.ok(types.has(node.type), `недопустимый type: ${node.type}`);
    assert.ok(!seen.has(node.id), `дубликат id: ${node.id}`);
    seen.add(node.id);

    for (const value of [node.layout.x, node.layout.y, node.layout.w, node.layout.h]) {
      assert.equal(Number(value.toFixed(2)), value, `${node.id}: больше двух знаков после запятой`);
    }
    // Инвариант 2: координаты относительны родителю, значит вложенный узел помещается в него.
    if (parent && parent.layout.mode === "none") {
      assert.ok(node.layout.x >= 0 && node.layout.y >= 0, `${node.id}: отрицательное смещение`);
    }
    // Инвариант 7: узлы без визуального вклада схлопнуты.
    assert.ok(node.layout.w > 0 && node.layout.h > 0, `${node.id}: нулевой размер`);
    // Инвариант 5: ссылка на токен не отменяет дублирующих полей.
    if (node.text?.token) {
      assert.ok(doc.tokens.text[node.text.token], `неизвестный токен ${node.text.token}`);
      assert.ok(node.text.size && node.text.weight, `${node.id}: токен без дублирующих полей`);
    }
    for (const color of [node.text?.color, node.style?.fill, node.style?.stroke]) {
      if (color) assert.match(color, /^(#[0-9A-F]{6}|rgba\(.+\))$/, `нестандартный цвет ${color}`);
    }
    for (const child of node.children ?? []) walk(child, node);
  };

  walk(doc.root);
  assert.equal(seen.size, 29);
});

test("vault_get_doc обрезает дерево по maxDepth и считает отброшенное", async () => {
  const full = await vault.getDoc(DOC);
  const shallow = await vault.getDoc(DOC, 1);
  assert.equal(shallow.root.children?.length, full.root.children?.length);
  assert.equal(shallow.root.childrenOmitted, undefined);

  const brand = shallow.root.children?.[0];
  assert.equal(brand?.id, "1:2");
  assert.deepEqual(brand?.children, []);
  assert.equal(brand?.childrenOmitted, 2);
  assert.equal(countNodes(shallow.root) + (shallow.truncation?.omittedNodes ?? 0), 29);

  const rootOnly = await vault.getDoc(DOC, 0);
  assert.deepEqual(rootOnly.root.children, []);
  assert.equal(rootOnly.root.childrenOmitted, 7);
  assert.equal(rootOnly.truncation?.omittedNodes, 28);
  // Обрезка не должна портить исходный документ в кеше файловой системы.
  assert.equal(countNodes((await vault.getDoc(DOC)).root), 29);
});

test("vault_get_node возвращает поддерево целиком", async () => {
  const node = await vault.getNode(DOC, "1:9");
  assert.equal(node.name, "Form");
  assert.equal(countNodes(node), 14);
  await assert.rejects(() => vault.getNode(DOC, "9:99"), VaultError);
});

test("vault_search ищет по имени и по тексту без учёта регистра", async () => {
  const byName = await vault.search(DOC, "input");
  assert.deepEqual(
    byName.hits.map((hit) => hit.id),
    ["1:12", "1:16"],
  );
  assert.deepEqual(byName.hits[0]?.path, ["Sign in / Mobile", "Form", "Field / Email", "Input"]);

  const byText = await vault.search(DOC, "войти");
  assert.deepEqual(
    byText.hits.map((hit) => hit.id),
    ["1:24"],
  );
  assert.deepEqual(byText.hits[0]?.matchedIn, ["text"]);

  const limited = await vault.search(DOC, "a", 2);
  assert.equal(limited.returned, 2);
  assert.ok(limited.total > 2);
  assert.equal(limited.hits.length, 2);

  assert.equal((await vault.search(DOC, "здесь-такого-нет")).total, 0);
  await assert.rejects(() => vault.search(DOC, "   "), VaultError);
});

test("vault_get_tokens отдаёт токены, на которые ссылаются узлы", async () => {
  const tokens = await vault.getTokens(DOC);
  assert.equal(tokens.colors["brand/500"], "#3B82F6");
  assert.equal(tokens.text["button/md"]?.weight, 600);
  assert.ok(tokens.effects["shadow/button"]);
});

test("vault_get_asset отдаёт растр base64, svg — исходником", async () => {
  const hero = await vault.getAsset(DOC, "assets/hero.png");
  assert.equal(hero.mimeType, "image/png");
  assert.equal(hero.encoding, "base64");
  assert.equal(Buffer.from(hero.data, "base64").subarray(1, 4).toString("ascii"), "PNG");

  const logo = await vault.getAsset(DOC, "assets/logo.svg");
  assert.equal(logo.encoding, "utf8");
  assert.match(logo.data, /^<svg/);

  const shot = await vault.getAsset(DOC, "screenshot.png");
  assert.ok(shot.bytes > 0);
});

test("vault не выпускает читателя за пределы документа", async () => {
  await assert.rejects(() => vault.getAsset(DOC, "../../package.json"), VaultError);
  await assert.rejects(() => vault.getAsset(DOC, "assets/../../../.env"), VaultError);
  await assert.rejects(() => vault.getAsset(DOC, "doc.json"), VaultError);
  await assert.rejects(() => vault.getDoc("../../etc"), VaultError);
  await assert.rejects(() => vault.getDoc("нет-такого-дока"), VaultError);
});

test("битый doc.json отбивается валидатором из src/shared, а не доходит до агента", async () => {
  const broken = new Vault(path.join(repoRoot, "vault", "example"));
  await assert.rejects(
    () => broken.getDoc("../../src"),
    (error: Error) => error instanceof VaultError,
  );
  // Фикстура обязана проходить общую схему doc@0 — иначе экспортёр целится не туда.
  validateVaultDocument(
    JSON.parse(
      await readFile(path.join(repoRoot, "vault", "example", DOC, "doc.json"), "utf8"),
    ),
  );
  validateVaultIndex(
    JSON.parse(await readFile(path.join(repoRoot, "vault", "example", "index.json"), "utf8")),
  );
  assert.throws(
    () => validateVaultDocument({ schema: "figma-vault/doc@1" }),
    /Invalid vault data/,
  );
});

test("пустой vault объясняет, что делать дальше", async () => {
  const empty = new Vault(path.join(repoRoot, "vault", "example", "EXAMPLE1234_1_1", "assets"));
  await assert.rejects(() => empty.list(), (error: Error) => {
    assert.ok(error instanceof VaultError);
    assert.match(error.message, /npm run pull/);
    return true;
  });
});

test("каталог vault берётся из флага, переменной окружения и умолчания", () => {
  assert.equal(resolveVaultDir(["--vault", "vault/example"], {}), "vault/example");
  assert.equal(resolveVaultDir([], { FIGMA_VAULT_DIR: "/tmp/v" }), "/tmp/v");
  assert.equal(resolveVaultDir([], {}), "vault");
  assert.throws(() => resolveVaultDir(["--oops"], {}));
  assert.throws(() => resolveVaultDir(["--vault"], {}));
});
