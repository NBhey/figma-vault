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

