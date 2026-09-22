export interface FigmaSelection {
  fileKey: string;
  nodeId: string;
}

const FILE_ROUTE = /^\/(?:design|file|proto|board)\/([^/]+)/;

export function parseFigmaUrl(value: string): FigmaSelection {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a full Figma URL");
  }

  if (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com")) {
    throw new Error(`Expected a figma.com URL, received ${url.hostname}`);
  }

  const match = url.pathname.match(FILE_ROUTE);
  if (!match?.[1]) {
    throw new Error("Could not find a Figma file key in the URL");
  }

  const rawNodeId = url.searchParams.get("node-id");
  if (!rawNodeId) {
    throw new Error("The Figma URL must contain a node-id query parameter");
  }

  const nodeId = decodeURIComponent(rawNodeId).replace(/-/g, ":");
  if (!/^\d+:\d+(?::\d+)*$/.test(nodeId)) {
    throw new Error(`Invalid Figma node id: ${rawNodeId}`);
  }

  return { fileKey: match[1], nodeId };
}

export function makeDocId(fileKey: string, nodeId: string): string {
  return `${fileKey}_${nodeId.replace(/[:-]/g, "_")}`;
}

export function safeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_.]/g, "_");
}

