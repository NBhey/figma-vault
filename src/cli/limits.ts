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
  if (seconds < 90) return `${Math.round(seconds)} с`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86_400)} сут`;
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
      'Нужна ссылка на фрейм: figma-vault limits "https://figma.com/design/...?node-id=1-42"\n' +
        "Проверка делает два запроса — те же, что и выгрузка.",
    );
  }
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("Не задан FIGMA_TOKEN.");

  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  const structure = await probe(
    "Чтение структуры  /v1/files/:key/nodes",
    `${BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`,
    token,
  );
  const render = await probe(
    "Рендер картинок   /v1/images/:key",
    `${BASE}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png`,
    token,
  );

  out("");
  for (const p of [structure, render]) {
    const mark = p.ok ? " OK " : p.status === 429 ? "ЛИМИТ" : "СБОЙ";
    out(`[${mark}] ${p.label} — HTTP ${p.status || "нет ответа"}`);
    if (p.retryAfter && p.retryAfter > 0) {
      out(`         освободится примерно через ${humanDuration(p.retryAfter)}`);
    }
    if (p.plan || p.kind) {
      const bits = [p.plan ? `тариф ${p.plan}` : null, p.kind ? `тип лимита ${p.kind}` : null]
        .filter(Boolean)
        .join(", ");
      out(`         ${bits}`);
    }
    if (!p.ok && p.detail) out(`         ${p.detail}`);
  }

  out("");
  if (structure.ok && render.ok) {
    out("Выгрузка пройдёт полностью: структура, скриншот и картинки.");
    out("Иконки собираются локально из геометрии и лимит не расходуют.");
  } else if (structure.ok && !render.ok) {
    out("Структура доступна, рендер картинок — нет.");
    out("Выгружайте с флагом --no-assets: будет дерево, тексты, отступы и цвета,");
    out("без скриншота и растровых картинок. Их доберёте позже тем же add без флага.");
    process.exitCode = 1;
  } else if (structure.status === 403) {
    out("Нет доступа к файлу. Проверьте, что у токена scope File content (read-only)");
    out("и что аккаунт, которому принадлежит токен, имеет доступ к этому файлу в Figma.");
    process.exitCode = 1;
  } else if (structure.status === 404) {
    out("Файл или узел не найден. Проверьте ссылку: в ней должен быть node-id.");
    process.exitCode = 1;
  } else {
    out("Выгрузка сейчас не пройдёт. Смотрите статусы выше.");
    process.exitCode = 1;
  }
}
