import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { countVaultNodes } from "./normalize.js";
import { makeDocId } from "./url.js";
import type { FigmaNodesResponse, SnapshotIndex, VaultDocument } from "./types.js";
import type { GeneratedArtifact } from "./geometry.js";

export interface RemoteArtifact {
  relativePath: string;
  url: string;
}

export interface WriteSnapshotInput {
  vaultDir: string;
  document: VaultDocument;
  raw: FigmaNodesResponse;
  artifacts: RemoteArtifact[];
  generatedArtifacts?: GeneratedArtifact[];
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
  realDirectory: string,
): Promise<void> {
  const target = artifactTarget(directory, artifact.relativePath);
  await ensureSafeDirectory(directory, realDirectory, path.dirname(target));
  await assertSafeFile(realDirectory, target);
  const response = await fetcher(artifact.url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${artifact.relativePath}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  await assertSafeFile(realDirectory, target);
  await writeFile(target, content);
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function artifactTarget(directory: string, relativePath: string): string {
  const target = path.resolve(directory, relativePath);
  if (!isInside(directory, target)) {
    throw new Error(`Artifact path escapes snapshot directory: ${relativePath}`);
  }
  return target;
}

async function ensureSafeDirectory(directory: string, realDirectory: string, target: string): Promise<void> {
  if (target === directory) return;
  if (!isInside(directory, target)) throw new Error(`Directory path leaves the vault: ${target}`);
  let current = directory;
  for (const part of path.relative(directory, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
    const realCurrent = await realpath(current);
    if (!isInside(realDirectory, realCurrent)) {
      throw new Error(`Directory path leaves the vault: ${current}`);
    }
  }
}

async function assertSafeFile(realDirectory: string, target: string): Promise<void> {
  const realParent = await realpath(path.dirname(target));
  if (realParent !== realDirectory && !isInside(realDirectory, realParent)) {
    throw new Error(`File path leaves the vault: ${target}`);
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${target}`);
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function writeGenerated(artifact: GeneratedArtifact, directory: string, realDirectory: string): Promise<void> {
  const target = artifactTarget(directory, artifact.relativePath);
  await ensureSafeDirectory(directory, realDirectory, path.dirname(target));
  await assertSafeFile(realDirectory, target);
  await writeFile(target, artifact.content);
}

export async function writeSnapshot(input: WriteSnapshotInput): Promise<WriteSnapshotResult> {
  const fetcher = input.fetcher ?? fetch;
  const { source } = input.document;
  const docId = makeDocId(source.fileKey, source.nodeId);
  if (!/^[A-Za-z0-9._-]+$/.test(docId) || docId === "." || docId === "..") {
    throw new Error(`Invalid document id: ${docId}`);
  }
  await mkdir(input.vaultDir, { recursive: true });
  const realVaultDir = await realpath(input.vaultDir);
  const directory = path.resolve(input.vaultDir, docId);
  if (!isInside(path.resolve(input.vaultDir), directory)) {
    throw new Error(`Document path leaves the vault: ${directory}`);
  }
  await mkdir(directory, { recursive: true });
  const realDirectory = await realpath(directory);
  if (!isInside(realVaultDir, realDirectory)) {
    throw new Error(`Document path leaves the vault: ${directory}`);
  }
  await ensureSafeDirectory(directory, realDirectory, path.join(directory, "assets"));

  const docPath = path.join(directory, "doc.json");
  const rawPath = path.join(directory, "raw.json");
  await Promise.all([assertSafeFile(realDirectory, docPath), assertSafeFile(realDirectory, rawPath)]);
  await Promise.all([
    writeFile(docPath, `${JSON.stringify(input.document, null, 2)}\n`, "utf8"),
    writeFile(rawPath, `${JSON.stringify(input.raw, null, 2)}\n`, "utf8"),
  ]);

  const warnings: string[] = [];
  const writtenAssets = new Set<string>();
  for (const artifact of input.generatedArtifacts ?? []) {
    try {
      await writeGenerated(artifact, directory, realDirectory);
      if (artifact.relativePath.startsWith("assets/")) writtenAssets.add(artifact.relativePath);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const artifact of input.artifacts) {
    try {
      await download(fetcher, artifact, directory, realDirectory);
      if (artifact.relativePath.startsWith("assets/")) writtenAssets.add(artifact.relativePath);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const indexPath = path.resolve(input.vaultDir, "index.json");
  await assertSafeFile(realVaultDir, indexPath);
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
  const temporaryIndex = `${indexPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryIndex, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryIndex, indexPath);

  return { docId, directory, assetCount: writtenAssets.size, warnings };
}
