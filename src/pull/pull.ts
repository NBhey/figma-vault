import path from "node:path";

import { FigmaApiError, FigmaClient, FigmaRenderError, getRootEntry } from "./client.js";
import {
  CONTAINER_TYPES,
  DEFAULT_MAX_SCREENS,
  expandContainers,
  ScreensSkippedError,
  type ContainerExpansion,
} from "./expand.js";
import { collectGeneratedSvgArtifacts } from "./geometry.js";
import { collectRenderTargets, countVaultNodes, normalizeFigmaResponse } from "./normalize.js";
import { writeSnapshot, type RemoteArtifact, type WriteSnapshotResult } from "./storage.js";
import { parseFigmaUrl, safeNodeId } from "./url.js";
import type { FigmaNodesResponse, VaultDocument } from "./types.js";

export interface PullOptions {
  token: string;
  vaultDir?: string;
  client?: FigmaClient;
  exportedAt?: string;
}

export interface PullResult extends WriteSnapshotResult {
  nodeCount: number;
}

export interface BatchPullOptions extends PullOptions {
  noAssets?: boolean;
  /** Ссылку на SECTION/CANVAS раскрыть в экраны. Стоит одного лишнего `/nodes` с `depth=1` на файл. */
  expand?: boolean;
  /** Предел экранов из раскрытия за запуск; явные ссылки в него не входят. */
  maxScreens?: number;
}

/**
 * `expandedFrom` — id SECTION/CANVAS, из которой получен экран. Исход с ошибкой
 * `ScreensSkippedError` — отчёт о пропущенных экранах контейнера, а не сбой.
 */
export type PullSelectionOutcome =
  | { url: string; fileKey: string; nodeId: string; expandedFrom?: string; result: PullResult; error?: never }
  | { url: string; fileKey?: string; nodeId?: string; expandedFrom?: string; error: Error; result?: never };

interface Selection {
  url: string;
  fileKey: string;
  nodeId: string;
  expandedFrom?: string;
}

interface PreparedSelection extends Selection {
  raw: FigmaNodesResponse;
  document: VaultDocument;
  png: string[];
  svg: string[];
}

function renderFailure(label: string, reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `${label} unavailable: ${message}`;
}

function settledImages(
  result: PromiseSettledResult<Record<string, string>>,
  requestedIds: string[],
): { images: Record<string, string>; completedIds: string[]; failedStatus?: number } {
  if (result.status === "fulfilled") return { images: result.value, completedIds: requestedIds };
  const error = result.reason;
  if (error instanceof FigmaRenderError) {
    return { images: error.partialImages, completedIds: error.completedIds, failedStatus: error.status };
  }
  return { images: {}, completedIds: [] };
}

export async function pullFigmaSelection(figmaUrl: string, options: PullOptions): Promise<PullResult> {
  const outcome = (await pullFigmaSelections([figmaUrl], options))[0];
  if (!outcome) throw new Error("No Figma selection was provided");
  if (outcome.error) throw outcome.error;
  return outcome.result;
}

function selectionKey(selection: Selection): string {
  return `${selection.fileKey}\0${selection.nodeId}`;
}

async function fetchSelections(
  client: FigmaClient,
  fileKey: string,
  selections: Selection[],
  entries: Map<string, FigmaNodesResponse>,
  errors: Map<string, Error>,
): Promise<void> {
  const ids = selections.map((selection) => selection.nodeId);
  try {
    const response = await client.getNodes(fileKey, ids);
    for (const selection of selections) {
      const entry = response.nodes?.[selection.nodeId];
      if (!entry) {
        errors.set(selectionKey(selection), new FigmaApiError(
          `Node ${selection.nodeId} was not found in file ${fileKey}`, 404,
        ));
      } else {
        entries.set(selectionKey(selection), {
          ...response,
          nodes: { [selection.nodeId]: entry },
        });
      }
    }
  } catch (error) {
    const status = error instanceof FigmaApiError ? error.status : undefined;
    if (selections.length > 1 && status !== 401 && status !== 403 && status !== 429) {
      const midpoint = Math.floor(selections.length / 2);
      await fetchSelections(client, fileKey, selections.slice(0, midpoint), entries, errors);
      await fetchSelections(client, fileKey, selections.slice(midpoint), entries, errors);
      return;
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const selection of selections) errors.set(selectionKey(selection), failure);
  }
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** После не-429 сбоя делим скриншоты, чтобы тяжёлый экран не лишал остальных рендера. */
async function recoverScreenshots(
  client: FigmaClient,
  fileKey: string,
  ids: string[],
  splitFirst = true,
): Promise<{ images: Record<string, string>; completedIds: string[]; rateLimited?: boolean }> {
  if (ids.length === 0) return { images: {}, completedIds: [] };
  if (splitFirst && ids.length > 1) {
    const midpoint = Math.floor(ids.length / 2);
    const first = await recoverScreenshots(client, fileKey, ids.slice(0, midpoint), false);
    if (first.rateLimited) return first;
    const second = await recoverScreenshots(client, fileKey, ids.slice(midpoint), false);
    return {
      images: { ...first.images, ...second.images },
      completedIds: [...first.completedIds, ...second.completedIds],
      rateLimited: second.rateLimited,
    };
  }
  try {
    return { images: await client.renderNodes(fileKey, ids, "png", 2), completedIds: ids };
  } catch (error) {
    const partial = settledImages({ status: "rejected", reason: error }, ids);
    if (partial.failedStatus === 429) return { ...partial, rateLimited: true };
    const remaining = ids.filter((id) => !partial.completedIds.includes(id));
    if (remaining.length <= 1) return partial;
    const recovered = await recoverScreenshots(client, fileKey, remaining);
    return {
      images: { ...partial.images, ...recovered.images },
      completedIds: unique([...partial.completedIds, ...recovered.completedIds]),
      rateLimited: recovered.rateLimited,
    };
  }
}

async function savePreparedSelections(
  client: FigmaClient,
  fileKey: string,
  prepared: PreparedSelection[],
  options: BatchPullOptions,
  outcomes: Map<string, PullSelectionOutcome>,
): Promise<void> {
  const screenshotIds = prepared.map((selection) => selection.nodeId);
  const pngIds = unique([...screenshotIds, ...prepared.flatMap((selection) => selection.png)]);
  const assetIds = unique(prepared.flatMap((selection) => selection.png));
  const svgIds = unique(prepared.flatMap((selection) => selection.svg));
  const separateScreenshots = prepared.some((selection) => selection.png.length >= 40);
  let png: ReturnType<typeof settledImages> = { images: {}, completedIds: [] };
  let svg: ReturnType<typeof settledImages> = { images: {}, completedIds: [] };
  let pngFailure: string | undefined;
  let svgFailure: string | undefined;

  if (!options.noAssets) {
    if (separateScreenshots) {
      const [screenshotResult, assetResult, svgResult] = await Promise.allSettled([
        client.renderNodes(fileKey, screenshotIds, "png", 2),
        client.renderNodes(fileKey, assetIds, "png", 2),
        client.renderNodes(fileKey, svgIds, "svg"),
      ]);
      const screenshots = settledImages(screenshotResult!, screenshotIds);
      const assets = settledImages(assetResult!, assetIds);
      png = {
        images: { ...screenshots.images, ...assets.images },
        completedIds: unique([...screenshots.completedIds, ...assets.completedIds]),
      };
      svg = settledImages(svgResult!, svgIds);
      const failures = [
        screenshotResult?.status === "rejected" ? renderFailure("Screenshot", screenshotResult.reason) : undefined,
        assetResult?.status === "rejected" ? renderFailure("Raster assets", assetResult.reason) : undefined,
      ].filter((warning): warning is string => warning !== undefined);
      if (failures.length > 0) pngFailure = failures.join("; ");
      if (svgResult?.status === "rejected") svgFailure = renderFailure("SVG fallback", svgResult.reason);
      if (screenshotResult?.status === "rejected" && screenshots.failedStatus !== 429) {
        const missing = screenshotIds.filter((id) => !screenshots.completedIds.includes(id));
        const recovered = await recoverScreenshots(client, fileKey, missing);
        Object.assign(png.images, recovered.images);
        png.completedIds = unique([...png.completedIds, ...recovered.completedIds]);
      }
    } else {
      const [pngResult, svgResult] = await Promise.allSettled([
        client.renderNodes(fileKey, pngIds, "png", 2),
        client.renderNodes(fileKey, svgIds, "svg"),
      ]);
      png = settledImages(pngResult!, pngIds);
      svg = settledImages(svgResult!, svgIds);
      if (pngResult?.status === "rejected") pngFailure = renderFailure("PNG renders", pngResult.reason);
      if (svgResult?.status === "rejected") svgFailure = renderFailure("SVG fallback", svgResult.reason);

      if (pngFailure && png.failedStatus !== 429) {
        const missingScreenshots = screenshotIds.filter((id) => !png.completedIds.includes(id));
        if (missingScreenshots.length > 0) {
          const recovered = await recoverScreenshots(client, fileKey, missingScreenshots);
          Object.assign(png.images, recovered.images);
          png.completedIds = unique([...png.completedIds, ...recovered.completedIds]);
        }
      }
    }
  }

  for (const selection of prepared) {
    const warnings: string[] = [];
    const rootType = getRootEntry(selection.raw, selection.nodeId).document.type;
    if (CONTAINER_TYPES.has(rootType)) {
      warnings.push(
        `${selection.nodeId} is a ${rootType}, exported as one document; ` +
          "pass --expand to export its frames as separate screens",
      );
    }
    const requiredPng = [selection.nodeId, ...selection.png];
    if (pngFailure && requiredPng.some((id) => !png.completedIds.includes(id))) warnings.push(pngFailure);
    if (svgFailure && selection.svg.some((id) => !svg.completedIds.includes(id))) warnings.push(svgFailure);

    const artifacts: RemoteArtifact[] = [];
    if (!options.noAssets) {
      const screenshot = png.images[selection.nodeId];
      if (screenshot) artifacts.push({ relativePath: "screenshot.png", url: screenshot });
      else if (png.completedIds.includes(selection.nodeId)) {
        warnings.push(`Figma did not render screenshot for ${selection.nodeId}`);
      }
      for (const id of selection.png) {
        const url = png.images[id];
        if (url) artifacts.push({ relativePath: `assets/${safeNodeId(id)}.png`, url });
        else if (png.completedIds.includes(id)) warnings.push(`Figma did not render PNG asset for ${id}`);
      }
      for (const id of selection.svg) {
        const url = svg.images[id];
        if (url) artifacts.push({ relativePath: `assets/${safeNodeId(id)}.svg`, url });
        else if (svg.completedIds.includes(id)) warnings.push(`Figma did not render SVG asset for ${id}`);
      }
    }

    try {
      const written = await writeSnapshot({
        vaultDir: path.resolve(options.vaultDir ?? "vault"),
        document: selection.document,
        raw: selection.raw,
        artifacts,
        generatedArtifacts: options.noAssets ? [] : collectGeneratedSvgArtifacts(
          getRootEntry(selection.raw, selection.nodeId).document,
        ),
      });
      outcomes.set(selectionKey(selection), {
        url: selection.url,
        fileKey,
        nodeId: selection.nodeId,
        expandedFrom: selection.expandedFrom,
        result: {
          ...written,
          warnings: [...written.warnings, ...warnings],
          nodeCount: countVaultNodes(selection.document.root),
        },
      });
    } catch (error) {
      outcomes.set(selectionKey(selection), {
        url: selection.url,
        fileKey,
        nodeId: selection.nodeId,
        expandedFrom: selection.expandedFrom,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

type InvalidLink = { url: string; error: Error };

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** Раскрытие SECTION/CANVAS по файлам; ключ — `selectionKey` контейнера либо ошибка обзора всего файла. */
async function expandSelections(
  client: FigmaClient,
  selections: Selection[],
  maxScreens: number,
): Promise<Map<string, ContainerExpansion | Error>> {
  const byFile = new Map<string, string[]>();
  for (const selection of selections) {
    const ids = byFile.get(selection.fileKey) ?? [];
    if (!ids.includes(selection.nodeId)) ids.push(selection.nodeId);
    byFile.set(selection.fileKey, ids);
  }
  const expansions = new Map<string, ContainerExpansion | Error>();
  let budget = maxScreens;
  for (const [fileKey, ids] of byFile) {
    try {
      // Явные ссылки не повторяются экранами из контейнеров.
      const found = await expandContainers(client, fileKey, ids, budget, new Set(ids));
      for (const [nodeId, expansion] of found) {
        expansions.set(selectionKey({ url: "", fileKey, nodeId }), expansion);
        budget -= expansion.screens.length;
      }
    } catch (reason) {
      for (const nodeId of ids) expansions.set(selectionKey({ url: "", fileKey, nodeId }), toError(reason));
    }
  }
  return expansions;
}

/** Export unique selections, sharing Figma reads and renders within each file. */
export async function pullFigmaSelections(
  urls: string[],
  options: BatchPullOptions,
): Promise<PullSelectionOutcome[]> {
  const parsed: Array<Selection | InvalidLink> = [];
  for (const url of urls) {
    try {
      parsed.push({ url, ...parseFigmaUrl(url) });
    } catch (error) {
      parsed.push({ url, error: toError(error) });
    }
  }
  const isSelection = (item: Selection | InvalidLink): item is Selection => !("error" in item);
  const valid = parsed.filter(isSelection);
  if (valid.length === 0) return parsed as InvalidLink[];

  const client = options.client ?? new FigmaClient(options.token);
  const maxScreens = options.maxScreens ?? DEFAULT_MAX_SCREENS;
  const expansions = options.expand
    ? await expandSelections(client, valid, maxScreens)
    : new Map<string, ContainerExpansion | Error>();

  const requested: Selection[] = [];
  const order: Array<{ key: string } | PullSelectionOutcome> = [];
  const seen = new Set<string>();
  const request = (selection: Selection) => {
    const key = selectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    requested.push(selection);
    order.push({ key });
  };
  for (const item of parsed) {
    if (!isSelection(item)) {
      order.push(item);
      continue;
    }
    const key = selectionKey(item);
    const expansion = expansions.get(key);
    if (!expansion) {
      request(item);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (expansion instanceof Error) {
      order.push({ ...item, error: expansion });
      continue;
    }
    for (const nodeId of expansion.screens) {
      request({ url: item.url, fileKey: item.fileKey, nodeId, expandedFrom: item.nodeId });
    }
    if (expansion.overLimit.length > 0 || expansion.tooDeep.length > 0) {
      order.push({ ...item, error: new ScreensSkippedError(item.nodeId, expansion, maxScreens) });
    } else if (expansion.screens.length === 0 && expansion.repeated.length === 0) {
      order.push({ ...item, error: new Error(`${item.nodeId} contains no visible frames to export`) });
    }
  }
  if (requested.length === 0) {
    return order.filter((item): item is PullSelectionOutcome => !("key" in item));
  }

  const groups = new Map<string, Selection[]>();
  for (const selection of requested) {
    const group = groups.get(selection.fileKey) ?? [];
    group.push(selection);
    groups.set(selection.fileKey, group);
  }

  const outcomes = new Map<string, PullSelectionOutcome>();
  for (const [fileKey, selections] of groups) {
    const entries = new Map<string, FigmaNodesResponse>();
    const errors = new Map<string, Error>();
    await fetchSelections(client, fileKey, selections, entries, errors);
    const prepared: PreparedSelection[] = [];
    for (const selection of selections) {
      const key = selectionKey(selection);
      const error = errors.get(key);
      if (error) {
        outcomes.set(key, { ...selection, error });
        continue;
      }
      const raw = entries.get(key)!;
      try {
        const root = getRootEntry(raw, selection.nodeId).document;
        const targets = options.noAssets ? { png: [], svg: [] } : collectRenderTargets(root);
        prepared.push({
          ...selection,
          raw,
          document: normalizeFigmaResponse(raw, fileKey, selection.nodeId, options.exportedAt),
          ...targets,
        });
      } catch (reason) {
        outcomes.set(key, {
          ...selection,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        });
      }
    }
    if (prepared.length > 0) {
      await savePreparedSelections(client, fileKey, prepared, options, outcomes);
    }
  }
  return order.map((item) => "key" in item ? outcomes.get(item.key)! : item);
}
