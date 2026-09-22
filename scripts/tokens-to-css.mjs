// Превращает tokens из doc.json в CSS-переменные и классы типографики.
//
//   node scripts/tokens-to-css.mjs <каталог макета в vault> <куда положить tokens.css>
//
// Смысл: в живом проекте значения не вбиваются руками в каждое правило. Дизайн-система
// приезжает из макета один раз, дальше вёрстка ссылается на имена.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , docDir, outFile] = process.argv;
if (!docDir || !outFile) {
  console.error("Usage: node scripts/tokens-to-css.mjs <vault/…/<docId>> <выходной .css>");
  process.exit(1);
}

const doc = JSON.parse(await readFile(path.join(docDir, "doc.json"), "utf8"));
const { colors = {}, text = {}, effects = {} } = doc.tokens ?? {};

/** Figma: "Input/Default Medium" → CSS: "input-default-medium" */
const slug = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s/_.]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();

const lines = [];
lines.push("/* Сгенерировано из doc.json. Не править руками — правьте макет и выгрузите заново. */");
lines.push(`/* Источник: ${doc.source.fileName} → ${doc.source.nodeName} */`);
lines.push("");
lines.push(":root{");

for (const [name, value] of Object.entries(colors)) {
  lines.push(`  --color-${slug(name)}: ${value};`);
}
for (const [name, value] of Object.entries(effects)) {
  lines.push(`  --shadow-${slug(name)}: ${value};`);
}

// Типографика — набором переменных на каждый токен, чтобы значения были доступны поштучно.
for (const [name, t] of Object.entries(text)) {
  const s = slug(name);
  lines.push(`  --font-${s}-size: ${t.size}px;`);
  lines.push(`  --font-${s}-line: ${t.lineHeight}px;`);
  lines.push(`  --font-${s}-weight: ${t.weight};`);
  lines.push(`  --font-${s}-tracking: ${t.letterSpacing}px;`);
}
lines.push("}");
lines.push("");

// …и готовым классом, чтобы разметка ссылалась на имя из дизайн-системы.
for (const [name, t] of Object.entries(text)) {
  const s = slug(name);
  lines.push(`.t-${s}{`);
  lines.push(`  font-family: ${JSON.stringify(t.font)}, Inter, system-ui, sans-serif;`);
  lines.push(`  font-size: var(--font-${s}-size);`);
  lines.push(`  line-height: var(--font-${s}-line);`);
  lines.push(`  font-weight: var(--font-${s}-weight);`);
  lines.push(`  letter-spacing: var(--font-${s}-tracking);`);
  lines.push("}");
}

await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
await writeFile(outFile, `${lines.join("\n")}\n`, "utf8");

console.log(`цветов:      ${Object.keys(colors).length}`);
console.log(`типографики: ${Object.keys(text).length}`);
console.log(`эффектов:    ${Object.keys(effects).length}`);
console.log(`записано:    ${outFile}`);
