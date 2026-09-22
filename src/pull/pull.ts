import path from "node:path";

import { FigmaClient, getRootEntry } from "./client.js";
import { collectGeneratedSvgArtifacts } from "./geometry.js";
import { collectRenderTargets, countVaultNodes, normalizeFigmaResponse } from "./normalize.js";
import { writeSnapshot, type RemoteArtifact, type WriteSnapshotResult } from "./storage.js";
import { parseFigmaUrl, safeNodeId } from "./url.js";

export interface PullOptions {
  token: string;
  vaultDir?: string;
  client?: FigmaClient;
  exportedAt?: string;
}

export interface PullResult extends WriteSnapshotResult {
  nodeCount: number;
}

export async function pullFigmaSelection(figmaUrl: string, options: PullOptions): Promise<PullResult> {
  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
  const client = options.client ?? new FigmaClient(options.token);
  const raw = await client.getNode(fileKey, nodeId);
  const rootEntry = getRootEntry(raw, nodeId);
  const document = normalizeFigmaResponse(raw, fileKey, nodeId, options.exportedAt);
  const targets = collectRenderTargets(rootEntry.document);
  const generatedArtifacts = collectGeneratedSvgArtifacts(rootEntry.document);

  const [screenshots, pngAssets, svgAssets] = await Promise.all([
    client.renderNodes(fileKey, [nodeId], "png", 2),
    client.renderNodes(fileKey, targets.png, "png", 2),
    client.renderNodes(fileKey, targets.svg, "svg"),
  ]);

  const artifacts: RemoteArtifact[] = [];
  if (screenshots[nodeId]) {
    artifacts.push({ relativePath: "screenshot.png", url: screenshots[nodeId] });
  }
  for (const [id, url] of Object.entries(pngAssets)) {
    artifacts.push({ relativePath: `assets/${safeNodeId(id)}.png`, url });
  }
  for (const [id, url] of Object.entries(svgAssets)) {
    artifacts.push({ relativePath: `assets/${safeNodeId(id)}.svg`, url });
  }

  const result = await writeSnapshot({
    vaultDir: path.resolve(options.vaultDir ?? "vault"),
    document,
    raw,
    artifacts,
    generatedArtifacts,
  });

  if (!screenshots[nodeId]) result.warnings.push(`Figma did not render screenshot for ${nodeId}`);
  for (const id of targets.png) {
    if (!pngAssets[id]) result.warnings.push(`Figma did not render PNG asset for ${id}`);
  }
  for (const id of targets.svg) {
    if (!svgAssets[id]) result.warnings.push(`Figma did not render SVG asset for ${id}`);
  }

  return { ...result, nodeCount: countVaultNodes(document.root) };
}
