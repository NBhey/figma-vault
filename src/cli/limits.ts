import { parseFigmaUrl } from "../pull/url.js";

/**
 * Проверка лимитов до выгрузки.
 *
 * У Figma два разных эндпоинта с разными бюджетами: чтение структуры и рендер картинок.
 * Рендер выбивается заметно раньше и блокируется надолго. Лимиты считаются по токену
 * и зависят от тарифа и типа места, поэтому узнать заранее можно только пробой.
 *
 * Команда делает ровно два запроса — те же самые, что сделала бы выгрузка, — и говорит,
 * пройдёт ли она, вместо того чтобы упасть на середине.
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
}

async function probe(label: string, url: string, token: string): Promise<Probe> {
  try {
    const response = await fetch(url, { headers: { "X-Figma-Token": token } });
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : null;
    let detail = "";
    if (!response.ok) {
      const body = await response.text();
      try {
        detail = (JSON.parse(body) as { message?: string; err?: string }).message
          ?? (JSON.parse(body) as { err?: string }).err
          ?? body.slice(0, 160);
      } catch {
        detail = body.slice(0, 160);
      }
    }
    return {
      label,
      status: response.status,
      ok: response.ok,
      retryAfter,
      plan: response.headers.get("x-figma-plan-tier"),
      kind: response.headers.get("x-figma-rate-limit-type"),
      detail,
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

export async function runLimits(figmaUrl: string | undefined): Promise<void> {
  if (!figmaUrl) {
    throw new Error(
      'A link to a frame is required: figma-vault limits "https://figma.com/design/...?node-id=1-42"\n' +
        "The check makes two requests — the same ones the export would make.",
    );
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("FIGMA_TOKEN is not set.");

  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  const structure = await probe(
    "Reading structure  /v1/files/:key/nodes",
    `${BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`,
    token,
  );
  const render = await probe(
    "Rendering images   /v1/images/:key",
    `${BASE}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png`,
    token,
  );

  out("");
  for (const p of [structure, render]) {
    const mark = p.ok ? " OK " : p.status === 429 ? "LIMIT" : "FAIL";
    out(`[${mark}] ${p.label} — HTTP ${p.status || "no answer"}`);
    if (p.retryAfter && p.retryAfter > 0) {
      out(`         frees up in about ${humanDuration(p.retryAfter)}`);
    }
    if (p.plan || p.kind) {
      const bits = [p.plan ? `plan ${p.plan}` : null, p.kind ? `limit type ${p.kind}` : null]
        .filter(Boolean)
        .join(", ");
      out(`         ${bits}`);
    }
    if (!p.ok && p.detail) out(`         ${p.detail}`);
  }

  out("");
  if (structure.ok && render.ok) {
    out("The export will go through completely: structure, screenshot and images.");
    out("Icons are built locally from geometry and do not spend the limit.");
  } else if (structure.ok && !render.ok) {
    out("The structure is available, image rendering is not.");
    out("Export with the --no-assets flag: you get the tree, texts, spacing and colors,");
    out("without the screenshot and raster images. Fetch them later with the same add without the flag.");
    process.exitCode = 1;
  } else if (structure.status === 403) {
    out("No access to the file. Check that the token has the File content (read-only) scope");
    out("and that the account owning the token has access to this file in Figma.");
    process.exitCode = 1;
  } else if (structure.status === 404) {
    out("File or node not found. Check the link: it must contain node-id.");
    process.exitCode = 1;
  } else {
    out("The export will not go through right now. See the statuses above.");
    process.exitCode = 1;
  }
}
