import { FigmaApiError, FigmaClient } from "../pull/client.js";
import { countVaultNodes, normalizeFigmaResponse } from "../pull/normalize.js";
import { pullFigmaSelection } from "../pull/pull.js";
import { writeSnapshot } from "../pull/storage.js";
import { parseFigmaUrl } from "../pull/url.js";

const TOKEN_HINT =
  "FIGMA_TOKEN is not set.\n" +
  "Figma → Settings → Security → Personal access tokens → Generate new token,\n" +
  "scope: File content (read-only). Put it into .env as FIGMA_TOKEN=figd_...";

const URL_HINT =
  'A link to a frame is required: figma-vault add "https://figma.com/design/...?node-id=1-42"\n' +
  "In Figma: right-click the frame → Copy link to selection.";

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
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
    process.stderr.write("Fetching the structure only, without images…\n");
    const result = await structureOnly(figmaUrl, options.vaultDir, token);
    out(`\nDone: ${result.docId}`);
    out(`  nodes:      ${result.nodeCount}`);
    out(`  directory:  ${result.directory}`);
    out("");
    out("The structure is in place: the layout can be rebuilt from it.");
    out("Images and the screenshot are missing — fetch them later with the same add without --no-assets.");
    return;
  }

  process.stderr.write("Talking to Figma…\n");
  try {
    const result = await pullFigmaSelection(figmaUrl, { token, vaultDir: options.vaultDir });
    out(`\nDone: ${result.docId}`);
    out(`  nodes:      ${result.nodeCount}`);
    out(`  directory:  ${result.directory}`);
    for (const warning of result.warnings) out(`  warning:    ${warning}`);
    out("");
    out("The design is in the vault. An agent reads it over MCP without calling Figma.");
    out("Commit the vault directory — then the team needs no token at all.");
  } catch (error) {
    if (error instanceof FigmaApiError && error.status === 429) {
      const wait =
        error.retryAfterSeconds !== undefined
          ? `Figma asks to wait ${humanDuration(error.retryAfterSeconds)}.\n`
          : "";
      const plan = error.planTier ? `Plan: ${error.planTier}. ` : "";
      const kind = error.rateLimitType ? `Limit type: ${error.rateLimitType}.` : "";
      const about = plan || kind ? `${plan}${kind}\n` : "";
      throw new Error(
        "Figma answered 429: the rate limit is exhausted, retries did not help.\n" +
          wait +
          about +
          "\nUsually it is image rendering that runs out first — its limit is stricter than the one for reading structure.\n" +
          "The structure of the design can normally be fetched right now:\n\n" +
          `  figma-vault add "<link>" --vault ${options.vaultDir} --no-assets\n\n` +
          "The layout can be rebuilt from it; fetch the images later with the same add without the flag.",
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
  if (response.ok) return "image rendering is available";
  if (response.status !== 429) return `image rendering answers ${response.status}`;
  const retryAfter = Number(response.headers.get("retry-after") ?? "0");
  return retryAfter > 0
    ? `image rendering is rate-limited, frees up in about ${humanDuration(retryAfter)}`
    : "image rendering is rate-limited, Figma did not say for how long";
}
