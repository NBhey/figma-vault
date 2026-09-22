import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { countVaultNodes } from "./normalize.js";
import { makeDocId } from "./url.js";
import type { FigmaNodesResponse, SnapshotIndex, VaultDocument } from "./types.js";

export interface RemoteArtifact {
  relativePath: string;
  url: string;
}

export interface WriteSnapshotInput {
  vaultDir: string;
  document: VaultDocument;
  raw: FigmaNodesResponse;
  artifacts: RemoteArtifact[];
  fetcher?: typeof fetch;
}

export interface WriteSnapshotResult {
  docId: string;
  directory: string;
  assetCount: number;
  warnings: string[];
}

async function readIndex(indexPath: string): Promise<SnapshotIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as SnapshotIndex;
    if (parsed.schema !== "figma-vault/index@0" || !Array.isArray(parsed.docs)) {
      throw new Error(`Unsupported vault index at ${indexPath}`);
    }
    return parsed;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { schema: "figma-vault/index@0", docs: [] };
    throw error;
  }
}

async function download(
  fetcher: typeof fetch,
  artifact: RemoteArtifact,
  directory: string,
): Promise<void> {
  const response = await fetcher(artifact.url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${artifact.relativePath}`);
  }
  const target = path.resolve(directory, artifact.relativePath);
  const relative = path.relative(directory, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes snapshot directory: ${artifact.relativePath}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

export async function writeSnapshot(input: WriteSnapshotInput): Promise<WriteSnapshotResult> {
  const fetcher = input.fetcher ?? fetch;
  const { source } = input.document;
  const docId = makeDocId(source.fileKey, source.nodeId);
  const directory = path.resolve(input.vaultDir, docId);
  await mkdir(path.join(directory, "assets"), { recursive: true });

  await Promise.all([
    writeFile(path.join(directory, "doc.json"), `${JSON.stringify(input.document, null, 2)}\n`, "utf8"),
    writeFile(path.join(directory, "raw.json"), `${JSON.stringify(input.raw, null, 2)}\n`, "utf8"),
  ]);

  const warnings: string[] = [];
  let assetCount = 0;
  for (const artifact of input.artifacts) {
    try {
      await download(fetcher, artifact, directory);
      if (artifact.relativePath.startsWith("assets/")) assetCount += 1;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const indexPath = path.resolve(input.vaultDir, "index.json");
  const index = await readIndex(indexPath);
  const entry = {
    docId,
    fileKey: source.fileKey,
    nodeId: source.nodeId,
    fileName: source.fileName,
    nodeName: source.nodeName,
    exportedAt: source.exportedAt,
    nodeCount: countVaultNodes(input.document.root),
  };
  index.docs = [...index.docs.filter((item) => item.docId !== docId), entry]
    .sort((a, b) => a.docId.localeCompare(b.docId));
  await mkdir(input.vaultDir, { recursive: true });
  const temporaryIndex = `${indexPath}.${process.pid}.tmp`;
  await writeFile(temporaryIndex, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporaryIndex, indexPath);

  return { docId, directory, assetCount, warnings };
}

