import type { FigmaNodeEntry, FigmaNodesResponse } from "./types.js";

type FetchLike = typeof fetch;

interface ImagesResponse {
  err?: string;
  images?: Record<string, string | null>;
}

export class FigmaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FigmaApiError";
  }
}

export class FigmaClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly baseUrl = "https://api.figma.com/v1",
  ) {
    if (!token.trim()) throw new Error("FIGMA_TOKEN is empty");
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: { "X-Figma-Token": this.token },
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new FigmaApiError(
          `Figma API ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
          response.status,
        );
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof FigmaApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new FigmaApiError("Figma API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
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

