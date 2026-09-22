// Собирает SVG-иконки из геометрии, которая уже есть в raw.json.
//
//   node scripts/vectors-to-svg.mjs <каталог макета в vault> <куда класть svg>
//
// Figma отдаёт fillGeometry/strokeGeometry вместе со структурой, если запрошен
// geometry=paths. Значит рендерить иконки через /v1/images не нужно вообще:
// именно эти запросы и выбивают лимит.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , docDir, outDir] = process.argv;
if (!docDir || !outDir) {
  console.error("Usage: node scripts/vectors-to-svg.mjs <vault/…/<docId>> <выходной каталог>");
  process.exit(1);
}

const raw = JSON.parse(await readFile(path.join(docDir, "raw.json"), "utf8"));
const rootId = Object.keys(raw.nodes)[0];
const root = raw.nodes[rootId].document;

const hex = (c, opacity = 1) => {
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  const a = (c.a ?? 1) * opacity;
  const base = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  return a >= 0.999 ? base : `${base}${to(a)}`;
};

/** Цвет первой видимой сплошной заливки. */
function solidFill(fills, opacity) {
  for (const fill of fills ?? []) {
    if (fill.visible === false) continue;
    if (fill.type !== "SOLID") continue;
    return hex(fill.color, (fill.opacity ?? 1) * (opacity ?? 1));
  }
  return null;
}

const GEOMETRY_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
]);

// Имя обязано совпадать с asset.path из doc.json: там : ; - заменены на _.
const safe = (id) => id.replace(/[:;\-]/g, "_");

let written = 0;
let skipped = 0;

async function emit(node) {
  const box = node.absoluteBoundingBox;
  const fillPaths = node.fillGeometry ?? [];
  const strokePaths = node.strokeGeometry ?? [];
  if (!box || (fillPaths.length === 0 && strokePaths.length === 0)) {
    skipped++;
    return;
  }

  const w = Math.max(box.width, 0.01);
  const h = Math.max(box.height, 0.01);
  const fillColor = solidFill(node.fills, node.opacity) ?? "currentColor";
  const strokeColor = solidFill(node.strokes, node.opacity) ?? fillColor;

  const body = [
    ...fillPaths.map(
      (p) =>
        `<path d="${p.path}" fill="${fillColor}"${
          p.windingRule === "EVENODD" ? ' fill-rule="evenodd" clip-rule="evenodd"' : ""
        }/>`,
    ),
    ...strokePaths.map((p) => `<path d="${p.path}" fill="${strokeColor}"/>`),
  ].join("");

  // Обводка, сконвертированная в контур, выходит за рамку узла на половину толщины.
  // Расширяем viewBox до фактических координат, иначе иконка обрезается по краям.
  const nums = [...fillPaths, ...strokePaths].flatMap((p) =>
    (p.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number),
  );
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  const minX = Math.min(0, ...xs);
  const minY = Math.min(0, ...ys);
  const vb = [minX, minY, Math.max(w, ...xs) - minX, Math.max(h, ...ys) - minY]
    .map((v) => +v.toFixed(2))
    .join(" ");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${+w.toFixed(2)}" height="${+h.toFixed(2)}" ` +
    `viewBox="${vb}" fill="none">${body}</svg>\n`;

  await writeFile(path.join(outDir, `${safe(node.id)}.svg`), svg, "utf8");
  written++;
}

/** Все векторные листья поддерева вместе с их рамками. */
function collectLeaves(node, acc = []) {
  if (node.visible === false) return acc;
  if (GEOMETRY_TYPES.has(node.type)) {
    if (node.absoluteBoundingBox && (node.fillGeometry?.length || node.strokeGeometry?.length)) {
      acc.push(node);
    }
    return acc;
  }
  for (const child of node.children ?? []) collectLeaves(child, acc);
  return acc;
}

/**
 * Иконка во Figma — это группа контуров. У отдельного контура рамка бывает вырожденной
 * (обводка без заливки даёт ширину или высоту 0), и сам по себе он не отрисуется.
 * Поэтому склеиваем все контуры группы в один SVG в системе координат группы.
 */
let merged = 0;
async function emitGroup(node) {
  const box = node.absoluteBoundingBox;
  const leaves = collectLeaves(node);
  if (!box || leaves.length === 0) return false;
  if (leaves.length === 1 && leaves[0] === node) return false;

  const w = Math.max(box.width, 0.01);
  const h = Math.max(box.height, 0.01);

  const body = leaves
    .map((leaf) => {
      const lb = leaf.absoluteBoundingBox;
      const dx = +(lb.x - box.x).toFixed(3);
      const dy = +(lb.y - box.y).toFixed(3);
      const fill = solidFill(leaf.fills, leaf.opacity) ?? solidFill(leaf.strokes, leaf.opacity) ?? "currentColor";
      const paths = [...(leaf.fillGeometry ?? []), ...(leaf.strokeGeometry ?? [])]
        .map(
          (p) =>
            `<path d="${p.path}" fill="${fill}"${
              p.windingRule === "EVENODD" ? ' fill-rule="evenodd" clip-rule="evenodd"' : ""
            }/>`,
        )
        .join("");
      return dx || dy ? `<g transform="translate(${dx} ${dy})">${paths}</g>` : paths;
    })
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${+w.toFixed(2)}" height="${+h.toFixed(2)}" ` +
    `viewBox="0 0 ${+w.toFixed(2)} ${+h.toFixed(2)}" fill="none">${body}</svg>\n`;

  await writeFile(path.join(outDir, `${safe(node.id)}.svg`), svg, "utf8");
  merged++;
  return true;
}

const GROUP_TYPES = new Set(["INSTANCE", "COMPONENT", "GROUP", "FRAME"]);

await mkdir(outDir, { recursive: true });

const queue = [root];
while (queue.length > 0) {
  const node = queue.shift();
  if (node.visible === false) continue;
  if (GEOMETRY_TYPES.has(node.type)) {
    await emit(node);
    continue;
  }
  if (GROUP_TYPES.has(node.type)) await emitGroup(node);
  for (const child of node.children ?? []) queue.push(child);
}
console.log(`склеенных групп-иконок: ${merged}`);

console.log(`SVG собрано: ${written}`);
console.log(`пропущено без геометрии: ${skipped}`);
console.log(`каталог: ${outDir}`);
console.log("Запросов к Figma: 0 — геометрия была в уже полученном ответе.");
