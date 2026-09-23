import { readFile } from "node:fs/promises";

import { Vault } from "../mcp/vault.js";
import type { VaultDocument } from "../pull/types.js";
import { verifySnapshot, type DomSnapshot, type VerifyReport } from "../pull/verify.js";
import { snapshotScript } from "./snapshot.js";

export interface VerifyOptions {
  vaultDir: string;
  snippet: boolean;
  snapshotFile?: string;
  tolerance?: number;
}

const out = (line = "") => process.stdout.write(`${line}\n`);

/** Коды выхода: агенту и CI нужно отличать «не совпало» от «нечем проверить». */
export const VERIFY_EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2 } as const;

const MAX_LISTED = 10;

/** docId можно не указывать, если макет в хранилище один. */
async function resolveDocId(vault: Vault, docId: string | undefined): Promise<string> {
  if (docId) return docId;
  const { docs } = await vault.list();
  if (docs.length === 1) return (docs[0] as { docId: string }).docId;
  throw new Error(
    `Specify a docId: the vault holds ${docs.length} designs.\n` +
      docs.map((doc) => `  ${doc.docId}  ${doc.nodeName}`).join("\n"),
  );
}

/** `scrollbar` пишет скрипт снимка сверх формата: ядру сверки поле не нужно, подсказке CLI — нужно. */
type Snapshot = DomSnapshot & { scrollbar?: number };

/**
 * Снимок агент сохраняет как вернул браузер. `page.evaluate` отдаёт уже строку JSON,
 * и её часто сохраняют ещё раз через JSON.stringify — принимаем оба вида.
 */

async function readSnapshot(file: string): Promise<Snapshot> {
  let value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof value === "string") value = JSON.parse(value);
  return value as Snapshot;
}

/**
 * Самое частое ложное расхождение: кадр 1280, окно 1280, но 15 px из них у полосы прокрутки,
 * и резиновая вёрстка выходит 1265. Вёрстка тут ни при чём — надо переснять снимок.
 */
function viewportHint(doc: VaultDocument, snapshot: Snapshot, report: VerifyReport): string | undefined {
  const frame = doc.root.layout.w;
  const rootWidth = report.geometry.mismatches.find((m) => m.id === doc.root.id && m.property === "w");
  if (!rootWidth) return undefined;
  const scrollbar = snapshot.scrollbar ?? 0;
  if (scrollbar > 0 && Math.abs(rootWidth.actual + scrollbar - frame) <= 1) {
    return (
      `Root width ${rootWidth.actual} instead of ${frame}: the scrollbar took ${scrollbar} px of the window. ` +
      `Take the snapshot again at a window width of ${frame + scrollbar} px or with scrollbars hidden.`
    );
  }
  if (snapshot.viewport.w !== frame) {
    return `Browser window is ${snapshot.viewport.w} px, the design frame is ${frame} px. Take the snapshot again at a window width of ${frame} px.`;
  }
  return undefined;
}

function printReport(docId: string, report: VerifyReport, tolerance: number, hint?: string): void {
  out(`Comparing the layout with design ${docId}\n`);

  const { text, geometry } = report;
  const textMark = text.missing.length === 0 ? " OK " : "FAIL";
  out(`[${textMark}] Texts — found in the layout ${text.matched} of ${text.total}`);
  for (const issue of text.missing.slice(0, MAX_LISTED)) {
    out(`        missing: ${JSON.stringify(issue.content)}  (${issue.id} ${issue.name})`);
  }
  if (text.missing.length > MAX_LISTED) out(`        … and ${text.missing.length - MAX_LISTED} more`);

  if (geometry.checkedNodes === 0) {
    out(`[WARN] Geometry — nothing to compare: no blocks with data-figma-node-id`);
  } else {
    const geoMark = geometry.mismatches.length === 0 ? " OK " : "FAIL";
    out(
      `[${geoMark}] Geometry — compared ${geometry.checkedNodes} blocks of ${geometry.visibleNodes} ` +
        `visible nodes, tolerance ${tolerance}px`,
    );
    for (const issue of geometry.mismatches.slice(0, MAX_LISTED)) {
      out(
        `        ${issue.id} ${issue.name}: ${issue.property} in the design ${issue.expected}, ` +
          `in the layout ${issue.actual} (difference ${issue.delta})`,
      );
    }
    if (geometry.mismatches.length > MAX_LISTED) {
      out(`        … and ${geometry.mismatches.length - MAX_LISTED} more`);
    }
  }
  for (const warning of report.warnings) out(`[WARN] ${warning}`);
  if (hint) out(`[WARN] ${hint}`);

  out();
  if (report.verdict === "PASS") {
    out("PASS: the texts are in place, the marked blocks match the design.");
  } else if (report.verdict === "FAIL") {
    out("FAIL: the layout diverges from the design, see the list above.");
  } else {
    out(
      "INCOMPLETE: no mismatches found, but there is nothing to check the geometry against.\n" +
        "Mark the root of the layout with data-figma-node-id carrying the id of the design root\n" +
        "and at least one nested block with the id of its node, then take the snapshot again.",
    );
  }
}

export async function runVerify(docIdArg: string | undefined, options: VerifyOptions): Promise<number> {
  const vault = new Vault(options.vaultDir);
  const docId = await resolveDocId(vault, docIdArg);
  const doc = (await vault.getRawDoc(docId)) as unknown as VaultDocument;

  if (options.snippet) {
    process.stdout.write(`${snapshotScript(doc.root.id)}\n`);
    return VERIFY_EXIT.PASS;
  }
  if (!options.snapshotFile) {
    throw new Error(
      "A snapshot of the layout is required: figma-vault verify <docId> --snapshot <file>.\n" +
        "How to get one: figma-vault verify <docId> --snippet prints a script — run it in\n" +
        "the browser on the built page and save the result into a file.",
    );
  }

  const tolerance = options.tolerance ?? 2;
  const snapshot = await readSnapshot(options.snapshotFile);
  const report = verifySnapshot(doc, snapshot, { tolerancePx: tolerance });
  printReport(docId, report, tolerance, viewportHint(doc, snapshot, report));
  return VERIFY_EXIT[report.verdict];
}
