import type { FigmaNodeEntry, FigmaNodesResponse } from "./types.js";

type FetchLike = typeof fetch;

interface ImagesResponse {
  err?: string;
  images?: Record<string, string | null>;
}

export interface FigmaRetryOptions {
  /** Number of retries after the initial request. */
  maxRetries?: number;
  /** Do not leave an interactive CLI sleeping for hours or days. */
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_DELAY_MS = 60_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class FigmaApiError extends Error {
  readonly retryAfterSeconds?: number;
  readonly planTier?: string;
  readonly rateLimitType?: string;
  readonly upgradeLink?: string;

  constructor(
    message: string,
    readonly status?: number,
    rateLimit?: {
      retryAfterSeconds?: number;
      planTier?: string;
      rateLimitType?: string;
      upgradeLink?: string;
    },
  ) {
    super(message);
    this.name = "FigmaApiError";
    this.retryAfterSeconds = rateLimit?.retryAfterSeconds;
    this.planTier = rateLimit?.planTier;
    this.rateLimitType = rateLimit?.rateLimitType;
    this.upgradeLink = rateLimit?.upgradeLink;
  }
}

export class FigmaClient {
  private readonly maxRetries: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly baseUrl = "https://api.figma.com/v1",
    retry: FigmaRetryOptions = {},
  ) {
    if (!token.trim()) throw new Error("FIGMA_TOKEN is empty");
    this.maxRetries = Math.max(0, Math.floor(retry.maxRetries ?? DEFAULT_MAX_RETRIES));
    this.maxDelayMs = Math.max(0, retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.sleep = retry.sleep ?? defaultSleep;
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await this.fetcher(`${this.baseUrl}${path}`, {
        headers: { "X-Figma-Token": this.token },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new FigmaApiError("Figma API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    let retries = 0;
    while (true) {
      const response = await this.request(path);
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        const retryAfter = retryAfterSeconds(response);
        const rateLimit = response.status === 429 ? {
          retryAfterSeconds: retryAfter,
          planTier: response.headers.get("x-figma-plan-tier") ?? undefined,
          rateLimitType: response.headers.get("x-figma-rate-limit-type") ?? undefined,
          upgradeLink: response.headers.get("x-figma-upgrade-link") ?? undefined,
        } : undefined;

        if (response.status === 429 && retries < this.maxRetries) {
          // Figma назвала срок — уважаем его. Не назвала — отступаем по 1с, 2с, 4с:
          // равные паузы подряд против лимита бесполезны.
          const delayMs =
            retryAfter !== undefined ? retryAfter * 1000 : 2 ** retries * 1000;
          if (delayMs <= this.maxDelayMs) {
            retries += 1;
            await this.sleep(delayMs);
            continue;
          }
        }

        const waitHint = response.status === 429 && retryAfter !== undefined
          ? `; retry after ${retryAfter} seconds`
          : "";
        throw new FigmaApiError(
          `Figma API ${response.status} ${response.statusText}${waitHint}${detail ? `: ${detail}` : ""}`,
          response.status,
          rateLimit,
        );
      }
      return await response.json() as T;
    }
  }

  async getNode(fileKey: string, nodeId: string): Promise<FigmaNodesResponse> {
    const params = new URLSearchParams({ ids: nodeId, geometry: "paths" });
    const response = await this.getJson<FigmaNodesResponse>(
      `/files/${encodeURIComponent(fileKey)}/nodes?${params}`,
    );
    if (!response.nodes?.[nodeId]) throw new FigmaApiError(`Node ${nodeId} was not found in file ${fileKey}`, 404);
    return response;
  }

  async renderNodes(
    fileKey: string,
    nodeIds: string[],
    format: "png" | "svg",
    scale?: number,
  ): Promise<Record<string, string>> {
    const images: Record<string, string> = {};
    for (let offset = 0; offset < nodeIds.length; offset += 40) {
      const ids = nodeIds.slice(offset, offset + 40);
      if (ids.length === 0) continue;
      const params = new URLSearchParams({ ids: ids.join(","), format });
      if (scale !== undefined) params.set("scale", String(scale));
      if (format === "svg") {
        params.set("svg_outline_text", "false");
        params.set("svg_include_node_id", "true");
      }
      const response = await this.getJson<ImagesResponse>(
        `/images/${encodeURIComponent(fileKey)}?${params}`,
      );
      if (response.err) throw new FigmaApiError(response.err);
      for (const [id, url] of Object.entries(response.images ?? {})) {
        if (url) images[id] = url;
      }
    }
    return images;
  }
}

export function getRootEntry(response: FigmaNodesResponse, nodeId: string): FigmaNodeEntry {
  const entry = response.nodes[nodeId];
  if (!entry) throw new FigmaApiError(`Figma returned an empty node for ${nodeId}`, 404);
  return entry;
}
