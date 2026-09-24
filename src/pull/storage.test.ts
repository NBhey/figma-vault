import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeSnapshot } from "./storage.js";
import type { FigmaNodesResponse, VaultDocument } from "./types.js";

const document: VaultDocument = {
  schema: "figma-vault/doc@0",
  source: {
    fileKey: "file",
    nodeId: "1:2",
    fileName: "Example",
    nodeName: "Root",
    exportedAt: "2026-09-22T00:00:00.000Z",
    figmaVersion: "1",
  },
  tokens: { colors: {}, text: {}, effects: {} },
  root: {
    id: "1:2",
    name: "Root",
    type: "frame",
    layout: { mode: "none", x: 0, y: 0, w: 100, h: 100 },
    children: [],
  },
};

const raw: FigmaNodesResponse = {
  name: "Example",
  nodes: { "1:2": { document: { id: "1:2", name: "Root", type: "FRAME" } } },
};

test("writeSnapshot creates a self-contained vault entry and index", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-test-"));
  try {
    const fetcher: typeof fetch = async () => new Response(Uint8Array.from([1, 2, 3]));
    const result = await writeSnapshot({
      vaultDir,
      document,
      raw,
      artifacts: [
        { relativePath: "screenshot.png", url: "https://assets.test/screenshot" },
        { relativePath: "assets/1_3.svg", url: "https://assets.test/icon" },
      ],
      generatedArtifacts: [
        { relativePath: "assets/1_4.svg", content: "<svg/>\n" },
      ],
      fetcher,
    });

    assert.equal(result.docId, "file_1_2");
    assert.equal(result.assetCount, 2);
    assert.deepEqual(result.warnings, []);
    const storedDoc = JSON.parse(await readFile(path.join(result.directory, "doc.json"), "utf8"));
    const index = JSON.parse(await readFile(path.join(vaultDir, "index.json"), "utf8"));
    assert.equal(storedDoc.source.nodeId, "1:2");
    assert.equal(index.docs[0].nodeCount, 1);
    assert.equal(await readFile(path.join(result.directory, "assets/1_4.svg"), "utf8"), "<svg/>\n");
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("writeSnapshot refuses artifact paths outside the snapshot", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-test-"));
  try {
    const fetcher: typeof fetch = async () => new Response(Uint8Array.from([1]));
    const result = await writeSnapshot({
      vaultDir,
      document,
      raw,
      artifacts: [{ relativePath: "../escape.txt", url: "https://assets.test/file" }],
      fetcher,
    });
    assert.equal(result.assetCount, 0);
    assert.match(result.warnings[0] ?? "", /escapes snapshot directory/);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("writeSnapshot refuses generated artifact paths outside the snapshot", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-test-"));
  try {
    const result = await writeSnapshot({
      vaultDir,
      document,
      raw,
      artifacts: [],
      generatedArtifacts: [{ relativePath: "../escape.svg", content: "<svg/>" }],
    });
    assert.equal(result.assetCount, 0);
    assert.match(result.warnings[0] ?? "", /escapes snapshot directory/);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("writeSnapshot rejects a document id containing path separators", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "figma-vault-test-"));
  try {
    const hostile = structuredClone(document);
    hostile.source.fileKey = "../escape";
    await assert.rejects(
      writeSnapshot({ vaultDir, document: hostile, raw, artifacts: [] }),
      /Invalid document id/,
    );
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("writeSnapshot refuses a document directory linked outside the vault", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "figma-vault-link-test-"));
  try {
    const vaultDir = path.join(base, "vault");
    const outside = path.join(base, "outside");
    await mkdir(vaultDir);
    await mkdir(outside);
    await writeFile(path.join(outside, "doc.json"), "keep");
    try {
      await symlink(outside, path.join(vaultDir, "file_1_2"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
      throw error;
    }

    await assert.rejects(
      writeSnapshot({ vaultDir, document, raw, artifacts: [] }),
      /Document path leaves the vault/,
    );
    assert.equal(await readFile(path.join(outside, "doc.json"), "utf8"), "keep");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeSnapshot refuses an assets directory linked outside the document", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "figma-vault-link-test-"));
  try {
    const vaultDir = path.join(base, "vault");
    const docDir = path.join(vaultDir, "file_1_2");
    const outside = path.join(base, "outside");
    await mkdir(docDir, { recursive: true });
    await mkdir(outside);
    try {
      await symlink(outside, path.join(docDir, "assets"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
      throw error;
    }

    await assert.rejects(
      writeSnapshot({ vaultDir, document, raw, artifacts: [] }),
      /Directory path leaves the vault/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeSnapshot refuses an existing document file symlink", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "figma-vault-link-test-"));
  try {
    const vaultDir = path.join(base, "vault");
    const docDir = path.join(vaultDir, "file_1_2");
    const outside = path.join(base, "outside.json");
    await mkdir(path.join(docDir, "assets"), { recursive: true });
    await writeFile(outside, "keep");
    try {
      await symlink(outside, path.join(docDir, "doc.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
      throw error;
    }

    await assert.rejects(
      writeSnapshot({ vaultDir, document, raw, artifacts: [] }),
      /Refusing to write through a symbolic link/,
    );
    assert.equal(await readFile(outside, "utf8"), "keep");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
