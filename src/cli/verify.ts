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
    `Укажите docId: макетов в хранилище ${docs.length}.\n` +
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
      `Ширина корня ${rootWidth.actual} вместо ${frame}: ${scrollbar} px окна заняла полоса прокрутки. ` +
      `Переснимите при ширине окна ${frame + scrollbar} px или со скрытыми полосами прокрутки.`
    );
  }
  if (snapshot.viewport.w !== frame) {
    return `Окно браузера ${snapshot.viewport.w} px, а кадр макета ${frame} px. Переснимите при ширине окна ${frame} px.`;
  }
  return undefined;
}

function printReport(docId: string, report: VerifyReport, tolerance: number, hint?: string): void {
  out(`Сверка вёрстки с макетом ${docId}\n`);

  const { text, geometry } = report;
  const textMark = text.missing.length === 0 ? " OK " : "СБОЙ";
  out(`[${textMark}] Тексты — найдено в вёрстке ${text.matched} из ${text.total}`);
  for (const issue of text.missing.slice(0, MAX_LISTED)) {
    out(`        нет: ${JSON.stringify(issue.content)}  (${issue.id} ${issue.name})`);
  }
  if (text.missing.length > MAX_LISTED) out(`        … и ещё ${text.missing.length - MAX_LISTED}`);

  if (geometry.checkedNodes === 0) {
    out(`[ВНИМ] Геометрия — не с чем сверять: нет блоков с data-figma-node-id`);
  } else {
    const geoMark = geometry.mismatches.length === 0 ? " OK " : "СБОЙ";
    out(
      `[${geoMark}] Геометрия — сверено блоков ${geometry.checkedNodes} из ${geometry.visibleNodes} ` +
        `видимых узлов, допуск ${tolerance}px`,
    );
    for (const issue of geometry.mismatches.slice(0, MAX_LISTED)) {
      out(
        `        ${issue.id} ${issue.name}: ${issue.property} в макете ${issue.expected}, ` +
          `в вёрстке ${issue.actual} (разница ${issue.delta})`,
      );
    }
    if (geometry.mismatches.length > MAX_LISTED) {
      out(`        … и ещё ${geometry.mismatches.length - MAX_LISTED}`);
    }
  }
  for (const warning of report.warnings) out(`[ВНИМ] ${warning}`);
  if (hint) out(`[ВНИМ] ${hint}`);

  out();
  if (report.verdict === "PASS") {
    out("PASS: тексты на месте, размеченные блоки совпадают с макетом.");
  } else if (report.verdict === "FAIL") {
    out("FAIL: вёрстка расходится с макетом, список выше.");
  } else {
    out(
      "INCOMPLETE: расхождений не найдено, но геометрию проверить нечем.\n" +
        "Пометьте корень вёрстки атрибутом data-figma-node-id с id корня макета\n" +
        "и хотя бы один вложенный блок — id его узла, и снимите снимок заново.",
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
      "Нужен снимок вёрстки: figma-vault verify <docId> --snapshot <файл>.\n" +
        "Как его получить: figma-vault verify <docId> --snippet печатает скрипт — выполните\n" +
        "его в браузере на свёрстанной странице и сохраните результат в файл.",
    );
  }

  const tolerance = options.tolerance ?? 2;
  const snapshot = await readSnapshot(options.snapshotFile);
  const report = verifySnapshot(doc, snapshot, { tolerancePx: tolerance });
  printReport(docId, report, tolerance, viewportHint(doc, snapshot, report));
  return VERIFY_EXIT[report.verdict];
}
