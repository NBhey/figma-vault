import { parseFigmaUrl } from "../pull/url.js";

/**
 * Проверка лимитов до выгрузки.
 *
 * Оба эндпоинта относятся к Tier 1. Доступный бюджет зависит от тарифа и типа места.
 *
 * Команда делает пробное чтение узлов и рендер выбранных экранов по файлам.
 * Ассеты и повторные попытки в этом прогнозе не учитываются.
 */

const BASE = "https://api.figma.com/v1";

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

interface Probe {
  label: string;
  status: number;
  ok: boolean;
  retryAfter: number | null;
  plan: string | null;
  kind: string | null;
  detail: string;
  nodeTypes?: Record<string, string>;
}

async function probe(label: string, url: string, token: string, readNodes = false): Promise<Probe> {
  try {
    const response = await fetch(url, { headers: { "X-Figma-Token": token } });
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : null;
    let detail = "";
    let nodeTypes: Record<string, string> | undefined;
    if (!response.ok) {
      const body = await response.text();
      try {
        detail = (JSON.parse(body) as { message?: string; err?: string }).message
          ?? (JSON.parse(body) as { err?: string }).err
          ?? body.slice(0, 160);
      } catch {
        detail = body.slice(0, 160);
      }
    } else if (readNodes) {
      const body = await response.json() as {
        nodes?: Record<string, { document?: { type?: string } } | null>;
      };
      nodeTypes = Object.fromEntries(Object.entries(body.nodes ?? {})
        .map(([id, entry]) => [id, entry?.document?.type ?? ""]));
    }
    return {
      label,
      status: response.status,
      ok: response.ok,
      retryAfter,
      plan: response.headers.get("x-figma-plan-tier"),
      kind: response.headers.get("x-figma-rate-limit-type"),
      detail,
      nodeTypes,
    };
  } catch (error) {
    return {
      label,
      status: 0,
      ok: false,
      retryAfter: null,
      plan: null,
      kind: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runLimits(figmaUrls: string[]): Promise<void> {
  if (figmaUrls.length === 0) {
    throw new Error(
      'At least one frame link is required: figma-vault limits "https://figma.com/design/...?node-id=1-42" [more links...]',
    );
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("FIGMA_TOKEN is not set.");
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const groups = new Map<string, string[]>();
  for (const url of figmaUrls) {
    try {
      const { fileKey, nodeId } = parseFigmaUrl(url);
      const ids = groups.get(fileKey) ?? [];
      if (!ids.includes(nodeId)) ids.push(nodeId);
      groups.set(fileKey, ids);
    } catch (error) {
      out(`[FAIL] ${url}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  for (const [fileKey, ids] of groups) {
    out(`\nFile ${fileKey}: ${ids.length} unique screen(s) (${ids.join(", ")})`);
    const structure = await probe(
      "Reading structure  /v1/files/:key/nodes",
      `${BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids.join(","))}&depth=1`,
      token,
      true,
    );
    const renderable = ids.filter((id) => ["FRAME", "COMPONENT", "INSTANCE"].includes(structure.nodeTypes?.[id] ?? ""));
    const containers = ids.filter((id) => ["SECTION", "CANVAS"].includes(structure.nodeTypes?.[id] ?? ""));
    const unknown = ids.filter((id) => structure.ok && !renderable.includes(id) && !containers.includes(id));
    const renders: Probe[] = [];
    for (let i = 0; i < renderable.length; i += 40) {
      const chunk = renderable.slice(i, i + 40);
      renders.push(await probe(
        "Rendering screens /v1/images/:key",
        `${BASE}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(chunk.join(","))}&format=png`,
        token,
      ));
    }
    for (const p of [structure, ...renders]) {
      const mark = p.ok ? " OK " : p.status === 429 ? "LIMIT" : "FAIL";
      out(`[${mark}] ${p.label} — HTTP ${p.status || "no answer"}`);
      if (p.retryAfter && p.retryAfter > 0) out(`         frees up in about ${humanDuration(p.retryAfter)}`);
      if (p.plan || p.kind) {
        out(`         ${[p.plan && `plan ${p.plan}`, p.kind && `limit type ${p.kind}`].filter(Boolean).join(", ")}`);
      }
      if (!p.ok && p.detail) out(`         ${p.detail}`);
    }
    if (containers.length > 0) {
      out(`Skipped image probe for ${containers.length} SECTION/CANVAS selection(s): ${containers.join(", ")}.`);
      out("Their child screens are not probed; add --expand exports them separately.");
    }
    if (unknown.length > 0) out(`Skipped image probe for unrecognized nodes: ${unknown.join(", ")}.`);
    out(`Probe requests used: ${1 + renders.length} (Tier 1).`);
    if (structure.ok && renderable.length > 0 && renders.every((render) => render.ok)) {
      out("Probed screens passed. Asset renders may still need more requests.");
    } else if (structure.ok && renders.some((render) => !render.ok)) {
      out("Structure is available; try add --no-assets if image rendering is limited.");
    } else if (structure.status === 403) {
      out("Check token scope and access to this Figma file.");
    } else if (structure.status === 404) {
      out("File or node not found; check the selection links.");
    }
    if (!structure.ok || renders.some((render) => !render.ok)) process.exitCode = 1;
  }
}
