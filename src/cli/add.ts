import { FigmaApiError } from "../pull/client.js";
import { ScreensSkippedError } from "../pull/expand.js";
import { pullFigmaSelections, type PullSelectionOutcome } from "../pull/pull.js";

const TOKEN_HINT =
  "FIGMA_TOKEN is not set.\n" +
  "Figma → Settings → Security → Personal access tokens → Generate new token,\n" +
  "scope: File content (read-only). Put it into .env as FIGMA_TOKEN=figd_...";

const URL_HINT =
  'At least one frame link is required: figma-vault add "https://figma.com/design/...?node-id=1-42" [more links...]\n' +
  "In Figma: right-click each frame → Copy link to selection.";

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

export interface AddOptions {
  vaultDir: string;
  noAssets: boolean;
  expand?: boolean;
  maxScreens?: number;
}

function failureMessage(outcome: PullSelectionOutcome): string {
  const error = outcome.error;
  if (!error) return "";
  if (!(error instanceof FigmaApiError) || error.status !== 429) return error.message;
  const wait = error.retryAfterSeconds !== undefined
    ? ` Figma asks to wait ${humanDuration(error.retryAfterSeconds)}.` : "";
  const details = [error.planTier && `plan ${error.planTier}`, error.rateLimitType && `limit type ${error.rateLimitType}`]
    .filter(Boolean).join(", ");
  return `Figma answered 429: the rate limit is exhausted.${wait}${details ? ` (${details})` : ""}`;
}

export async function runAdd(figmaUrls: string[], options: AddOptions): Promise<void> {
  if (figmaUrls.length === 0) throw new Error(URL_HINT);
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error(TOKEN_HINT);

  const out = (line: string) => process.stdout.write(`${line}\n`);
  process.stderr.write(options.noAssets
    ? "Fetching structures without images…\n" : "Talking to Figma…\n");
  const outcomes = await pullFigmaSelections(figmaUrls, {
    token, vaultDir: options.vaultDir, noAssets: options.noAssets,
    expand: options.expand, maxScreens: options.maxScreens,
  });
  let failed = 0;
  let exported = 0;
  let rateLimited = false;
  for (const outcome of outcomes) {
    out(`\n${outcome.url}${outcome.expandedFrom ? ` → ${outcome.nodeId}` : ""}`);
    if (outcome.error instanceof ScreensSkippedError) {
      out(`  warning:    ${outcome.error.message}`);
      continue;
    }
    if (outcome.error) {
      failed += 1;
      if (outcome.error instanceof FigmaApiError && outcome.error.status === 429) rateLimited = true;
      out(`  failed:     ${failureMessage(outcome)}`);
      continue;
    }
    exported += 1;
    out(`  done:       ${outcome.result.docId}`);
    out(`  nodes:      ${outcome.result.nodeCount}`);
    out(`  directory:  ${outcome.result.directory}`);
    for (const warning of outcome.result.warnings) out(`  warning:    ${warning}`);
  }
  out("");
  out(`${exported} exported, ${failed} failed.`);
  if (rateLimited) {
    out(options.noAssets
      ? "Retry the same command after the rate limit resets."
      : `If structure reads are available, retry the same command with --no-assets${options.expand ? " and keep --expand" : ""}.`);
  }
  if (options.noAssets && exported > 0) {
    out("Images and screenshots are missing; run the same add without --no-assets later.");
  }
  else if (exported > 0) out("Commit the vault directory so the team can read it without a Figma token.");
  if (failed > 0) process.exitCode = 1;
}

/** Сколько ждать до снятия лимита, если Figma сказала. */
