import path from "node:path";

import { FigmaClient, FigmaRenderError, getRootEntry } from "./client.js";
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

function renderFailure(label: string, reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `${label} unavailable: ${message}`;
}

function settledImages(
  result: PromiseSettledResult<Record<string, string>>,
  label: string,
  warnings: string[],
  requestedIds: string[],
): { images: Record<string, string>; completedIds: string[]; failedStatus?: number } {
  if (result.status === "fulfilled") return { images: result.value, completedIds: requestedIds };
  warnings.push(renderFailure(label, result.reason));
  const error = result.reason;
  if (error instanceof FigmaRenderError) {
    return { images: error.partialImages, completedIds: error.completedIds, failedStatus: error.status };
  }
  return { images: {}, completedIds: [] };
}

export async function pullFigmaSelection(figmaUrl: string, options: PullOptions): Promise<PullResult> {
  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
  const client = options.client ?? new FigmaClient(options.token);
  const raw = await client.getNode(fileKey, nodeId);
  const rootEntry = getRootEntry(raw, nodeId);
  const document = normalizeFigmaResponse(raw, fileKey, nodeId, options.exportedAt);
  const targets = collectRenderTargets(rootEntry.document);
  const generatedArtifacts = collectGeneratedSvgArtifacts(rootEntry.document);

  const renderWarnings: string[] = [];
  const pngIds = [nodeId, ...targets.png.filter((id) => id !== nodeId)];
  let screenshots: ReturnType<typeof settledImages>;
  let pngAssets: ReturnType<typeof settledImages>;
  let svgAssets: ReturnType<typeof settledImages>;

  if (pngIds.length <= 40) {
    const [pngResult, svgResult] = await Promise.allSettled([
      client.renderNodes(fileKey, pngIds, "png", 2),
      client.renderNodes(fileKey, targets.svg, "svg"),
    ]);
    const combined = settledImages(pngResult!, "PNG renders", renderWarnings, pngIds);
    pngAssets = combined;
    screenshots = combined;
    svgAssets = settledImages(svgResult!, "SVG fallback", renderWarnings, targets.svg);

    if (targets.png.length > 0 && !combined.images[nodeId]
      && pngResult?.status === "rejected" && combined.failedStatus !== 429) {
      const retry = await Promise.allSettled([client.renderNodes(fileKey, [nodeId], "png", 2)]);
      const recovered = settledImages(retry[0]!, "Screenshot", renderWarnings, [nodeId]);
      screenshots = recovered;
    }
  } else {
    const [screenshotResult, pngResult, svgResult] = await Promise.allSettled([
      client.renderNodes(fileKey, [nodeId], "png", 2),
      client.renderNodes(fileKey, targets.png, "png", 2),
      client.renderNodes(fileKey, targets.svg, "svg"),
    ]);
    screenshots = settledImages(screenshotResult!, "Screenshot", renderWarnings, [nodeId]);
    pngAssets = settledImages(pngResult!, "Raster assets", renderWarnings, targets.png);
    svgAssets = settledImages(svgResult!, "SVG fallback", renderWarnings, targets.svg);
  }

  const artifacts: RemoteArtifact[] = [];
  if (screenshots.images[nodeId]) {
    artifacts.push({ relativePath: "screenshot.png", url: screenshots.images[nodeId] });
  }
  for (const [id, url] of Object.entries(pngAssets.images)) {
    if (id === nodeId && !targets.png.includes(id)) continue;
    artifacts.push({ relativePath: `assets/${safeNodeId(id)}.png`, url });
  }
  for (const [id, url] of Object.entries(svgAssets.images)) {
    artifacts.push({ relativePath: `assets/${safeNodeId(id)}.svg`, url });
  }

  const result = await writeSnapshot({
    vaultDir: path.resolve(options.vaultDir ?? "vault"),
    document,
    raw,
    artifacts,
    generatedArtifacts,
  });
  result.warnings.push(...renderWarnings);

  if (!screenshots.images[nodeId] && screenshots.completedIds.includes(nodeId)) {
    result.warnings.push(`Figma did not render screenshot for ${nodeId}`);
  }
  for (const id of targets.png) {
    if (!pngAssets.images[id] && pngAssets.completedIds.includes(id)) {
      result.warnings.push(`Figma did not render PNG asset for ${id}`);
    }
  }
  for (const id of targets.svg) {
    if (!svgAssets.images[id] && svgAssets.completedIds.includes(id)) {
      result.warnings.push(`Figma did not render SVG asset for ${id}`);
    }
  }

  return { ...result, nodeCount: countVaultNodes(document.root) };
}
