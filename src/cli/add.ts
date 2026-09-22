import { FigmaApiError, FigmaClient } from "../pull/client.js";
import { countVaultNodes, normalizeFigmaResponse } from "../pull/normalize.js";
import { pullFigmaSelection } from "../pull/pull.js";
import { writeSnapshot } from "../pull/storage.js";
import { parseFigmaUrl } from "../pull/url.js";

const TOKEN_HINT =
  "Не задан FIGMA_TOKEN.\n" +
  "Figma → Settings → Security → Personal access tokens → Generate new token,\n" +
  "scope: File content (read-only). Положите его в .env строкой FIGMA_TOKEN=figd_...";

const URL_HINT =
  'Нужна ссылка на фрейм: figma-vault add "https://figma.com/design/...?node-id=1-42"\n' +
  "В Figma: правая кнопка по фрейму → Copy link to selection.";

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} с`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86_400)} сут`;
}

/**
 * Рендер картинок и чтение структуры — разные эндпоинты Figma с разными лимитами.
 * Картинки выбиваются в 429 заметно раньше, поэтому структуру можно забрать отдельно.
 */
async function structureOnly(
  figmaUrl: string,
  vaultDir: string,
  token: string,
): Promise<{ docId: string; directory: string; nodeCount: number }> {
  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
  const client = new FigmaClient(token);
  const raw = await client.getNode(fileKey, nodeId);
  const document = normalizeFigmaResponse(raw, fileKey, nodeId);
  const result = await writeSnapshot({ vaultDir, document, raw, artifacts: [] });
  return { ...result, nodeCount: countVaultNodes(document.root) };
}

export interface AddOptions {
  vaultDir: string;
  noAssets: boolean;
}

export async function runAdd(figmaUrl: string | undefined, options: AddOptions): Promise<void> {
  if (!figmaUrl) throw new Error(URL_HINT);
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error(TOKEN_HINT);

  const out = (line: string) => process.stdout.write(`${line}\n`);

  if (options.noAssets) {
    process.stderr.write("Забираю только структуру, без картинок…\n");
    const result = await structureOnly(figmaUrl, options.vaultDir, token);
    out(`\nГотово: ${result.docId}`);
    out(`  узлов:    ${result.nodeCount}`);
    out(`  каталог:  ${result.directory}`);
    out("");
    out("Структура на месте: вёрстку по ней восстановить можно.");
    out("Картинок и скриншота нет — доберите их позже тем же add без --no-assets.");
    return;
  }

  process.stderr.write("Обращаюсь к Figma…\n");
  try {
    const result = await pullFigmaSelection(figmaUrl, { token, vaultDir: options.vaultDir });
    out(`\nГотово: ${result.docId}`);
    out(`  узлов:    ${result.nodeCount}`);
    out(`  каталог:  ${result.directory}`);
    for (const warning of result.warnings) out(`  внимание: ${warning}`);
    out("");
    out("Макет в хранилище. Агент прочитает его через MCP без обращений к Figma.");
    out("Закоммитьте каталог хранилища — тогда команде не нужен токен.");
  } catch (error) {
    if (error instanceof FigmaApiError && error.status === 429) {
      throw new Error(
        "Figma ответила 429: исчерпан лимит обращений.\n\n" +
          "Чаще всего выбивается рендер картинок — у него лимит строже, чем у чтения структуры.\n" +
          "Структуру макета обычно можно забрать прямо сейчас:\n\n" +
          `  figma-vault add "<ссылка>" --vault ${options.vaultDir} --no-assets\n\n` +
          "Вёрстку по ней восстановить можно; картинки доберёте позже тем же add без флага.",
      );
    }
    throw error;
  }
}

/** Сколько ждать до снятия лимита, если Figma сказала. */
export async function rateLimitStatus(fileKey: string, nodeId: string, token: string): Promise<string> {
  const response = await fetch(
    `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png`,
    { headers: { "X-Figma-Token": token } },
  );
  if (response.ok) return "рендер картинок доступен";
  if (response.status !== 429) return `рендер картинок отвечает ${response.status}`;
  const retryAfter = Number(response.headers.get("retry-after") ?? "0");
  return retryAfter > 0
    ? `рендер картинок под лимитом, освободится примерно через ${humanDuration(retryAfter)}`
    : "рендер картинок под лимитом, срок Figma не сообщила";
}
