import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readVaultDocument, readVaultIndex, validateVaultDocument, VaultValidationError } from "./validate.js";

const fixtureRoot = path.resolve("vault/example");

test("the example vault conforms to doc@0 and index@0", async () => {
  const index = await readVaultIndex(path.join(fixtureRoot, "index.json"));
  assert.equal(index.docs.length, 1);
  const doc = await readVaultDocument(path.join(fixtureRoot, index.docs[0]!.docId, "doc.json"));
  assert.equal(doc.schema, "figma-vault/doc@0");
  assert.equal(doc.root.id, index.docs[0]!.nodeId);
});

test("validator includes the failing property path", () => {
  assert.throws(
    () => validateVaultDocument({ schema: "figma-vault/doc@0", source: {}, tokens: {}, root: {} }, "broken.json"),
    (error: unknown) => {
      assert.ok(error instanceof VaultValidationError);
      assert.equal(error.source, "broken.json");
      assert.match(error.message, /source\.fileKey/);
      assert.match(error.message, /root\.layout/);
      return true;
    },
  );
});

test("validator rejects unknown schema versions", () => {
  assert.throws(
    () => validateVaultDocument({ schema: "figma-vault/doc@999" }),
    /Invalid vault data/,
  );
});

test("validator accepts doc@1 text runs and hidden slots while retaining doc@0", async () => {
  const oldDoc = await readVaultDocument(path.join(fixtureRoot, "EXAMPLE1234_1_1", "doc.json"));
  assert.equal(oldDoc.schema, "figma-vault/doc@0");
  const upgraded = structuredClone(oldDoc);
  upgraded.schema = "figma-vault/doc@1";
  upgraded.root.children.push({
    id: "hidden:1",
    name: "Optional label",
    type: "text",
    hidden: true,
    layout: { mode: "none", x: 0, y: 0, w: 20, h: 20 },
    text: {
      content: "Hi!",
      color: "#FFFFFF",
      runs: [
        { start: 0, end: 2, color: "#FFFFFF", weight: 400 },
        { start: 2, end: 3, color: "#000000", weight: 900 },
      ],
    },
    children: [],
  });
  assert.equal(validateVaultDocument(upgraded).schema, "figma-vault/doc@1");
  upgraded.root.children.at(-1)!.text!.runs![1]!.start = 1;
  assert.throws(() => validateVaultDocument(upgraded), /text runs must be ordered/);
});
