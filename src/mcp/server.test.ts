import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.js";
import { Vault } from "./vault.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = "EXAMPLE1234_1_1";

/** Полный круг по протоколу MCP: клиент ↔ сервер, как у Claude Code или Codex. */
async function connect(): Promise<Client> {
  const server = createServer(new Vault(path.join(repoRoot, "vault", "example")));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  assert.equal(content[0]?.type, "text");
  return content[0]?.text ?? "";
}

test("сервер объявляет ровно шесть инструментов из контракта", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "vault_get_asset",
      "vault_get_doc",
      "vault_get_node",
      "vault_get_tokens",
      "vault_list",
      "vault_search",
    ],
  );
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} без описания`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} должен быть readOnly`);
  }
  await client.close();
});

test("метаданные для агента английские: инструкции, заголовки, описания и аргументы", async () => {
  const client = await connect();

  const instructions = client.getInstructions() ?? "";
  assert.ok(instructions.length > 0, "сервер обязан объяснить агенту, с чего начинать");
  assert.doesNotMatch(instructions, /[А-Яа-я]/, instructions);
  assert.match(instructions, /Start with vault_list/);

  const { tools } = await client.listTools();
  for (const tool of tools) {
    // Всё, что MCP-клиент показывает агенту или человеку: title, description и описания аргументов.
    const shown = [tool.title, tool.annotations?.title, tool.description, JSON.stringify(tool.inputSchema)]
      .filter(Boolean)
      .join("\n");
    assert.doesNotMatch(shown, /[А-Яа-я]/, `${tool.name}: ${shown}`);
  }

  const doc = tools.find((tool) => tool.name === "vault_get_doc");
  const properties = (doc?.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  assert.match(properties.docId?.description ?? "", /Document id/);
  assert.match(properties.includeHidden?.description ?? "", /hidden in Figma/);

  await client.close();
});

test("инструменты отвечают через протокол", async () => {
  const client = await connect();

  const list = JSON.parse(text(await client.callTool({ name: "vault_list", arguments: {} })));
  assert.equal(list.docs[0].docId, DOC);

  const doc = JSON.parse(
    text(await client.callTool({ name: "vault_get_doc", arguments: { docId: DOC, maxDepth: 0 } })),
  );
  assert.equal(doc.root.childrenOmitted, 7);

  const node = JSON.parse(
    text(await client.callTool({ name: "vault_get_node", arguments: { docId: DOC, nodeId: "1:23" } })),
  );
  assert.equal(node.component, "Button/Primary");

  const found = JSON.parse(
    text(await client.callTool({ name: "vault_search", arguments: { docId: DOC, query: "пароль" } })),
  );
  assert.deepEqual(
    found.hits.map((hit: { id: string }) => hit.id),
    ["1:15", "1:22"],
  );

  const tokens = JSON.parse(
    text(await client.callTool({ name: "vault_get_tokens", arguments: { docId: DOC } })),
  );
  assert.equal(tokens.colors["brand/500"], "#3B82F6");

  await client.close();
});

test("vault_get_asset отдаёт картинку как image, а svg как текст", async () => {
  const client = await connect();

  const png = (await client.callTool({
    name: "vault_get_asset",
    arguments: { docId: DOC, path: "assets/hero.png" },
  })) as { content: Array<{ type: string; mimeType?: string; data?: string }> };
  assert.equal(png.content[0]?.type, "image");
  assert.equal(png.content[0]?.mimeType, "image/png");

  const svg = await client.callTool({
    name: "vault_get_asset",
    arguments: { docId: DOC, path: "assets/logo.svg" },
  });
  assert.match(text(svg), /^<svg/);

  await client.close();
});

test("ошибка домена возвращается агенту, а не роняет сервер", async () => {
  const client = await connect();

  const missing = (await client.callTool({
    name: "vault_get_node",
    arguments: { docId: DOC, nodeId: "9:99" },
  })) as { isError?: boolean };
  assert.equal(missing.isError, true);
  assert.match(text(missing), /vault_search/);

  const escape = (await client.callTool({
    name: "vault_get_asset",
    arguments: { docId: DOC, path: "../../package.json" },
  })) as { isError?: boolean };
  assert.equal(escape.isError, true);

  // Сервер жив и обслуживает следующий вызов.
  assert.ok(JSON.parse(text(await client.callTool({ name: "vault_list", arguments: {} }))).docs);

  await client.close();
});
