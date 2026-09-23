import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Официальный MCP Registry сверяет `server.json` с опубликованным npm-пакетом: имя должно
 * совпасть с `mcpName`, версия — существовать в npm. При подъёме версии легко забыть
 * `server.json`, и публикация записи тогда упадёт уже после `npm publish`.
 */
async function readJson(relative: string): Promise<any> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("server.json согласован с package.json: имя, пакет и обе версии", async () => {
  const pkg = await readJson("../../package.json");
  const server = await readJson("../../server.json");

  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  const [npm] = server.packages;
  assert.equal(npm.registryType, "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.deepEqual(npm.packageArguments, [{ type: "positional", value: "mcp" }]);
  assert.ok(server.description.length <= 100, "Registry ограничивает description 100 символами");
});
