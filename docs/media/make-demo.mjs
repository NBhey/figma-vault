// Собирает docs/media/demo.svg — анимацию терминала для README.
// Строки взяты из реального вывода `figma-vault init && demo && check` (0.1.2) в пустом
// каталоге. Изменился вывод CLI — поправь SCRIPT и запусти: node docs/media/make-demo.mjs
import { writeFileSync } from 'node:fs';

const SCRIPT = [
  { cmd: 'figma-vault init' },
  { out: 'Vault:          .figma-vault/', cls: 'dim' },
  { out: '.mcp.json:      entry added (server figma-vault)', cls: 'dim' },
  { out: '.claude/commands/figma.md: created', cls: 'dim' },
  { gap: true },
  { cmd: 'figma-vault demo' },
  { out: 'Design copied: EXAMPLE1234_1_1', cls: 'dim' },
  { gap: true },
  { cmd: 'figma-vault check' },
  { tag: '[ OK ]', cls: 'ok', out: ' .mcp.json — the figma-vault server is registered' },
  { tag: '[ OK ]', cls: 'ok', out: ' Vault — .figma-vault/, designs: 1' },
  { tag: '[ OK ]', cls: 'ok', out: ' Design EXAMPLE1234_1_1 — nodes: 29' },
  { tag: '[ OK ]', cls: 'ok', out: ' MCP server — tools: 6 (vault_list, vault_get_doc, vault_get_node, …)' },
  { tag: '[WARN]', cls: 'warn', out: ' FIGMA_TOKEN — not set — reading designs from the vault works' },
  { gap: true },
  { out: 'The chain works: an agent will read the designs from the vault without calling Figma.', cls: 'strong' },
];

const W = 920, PAD = 24, TOP = 52, LH = 23, FS = 14;
const TYPE = 0.055, AFTER_CMD = 0.45, LINE = 0.14, HOLD = 4.5, FADE = 0.6;

// Раскладка по времени: команда печатается посимвольно, вывод появляется построчно.
let t = 0.6;
const items = [];
for (const s of SCRIPT) {
  if (s.gap) { t += 0.35; items.push({ gap: true }); continue; }
  if (s.cmd) {
    const chars = [...s.cmd].map((c) => { const at = t; t += TYPE; return { c, at }; });
    items.push({ cmd: true, at: chars[0].at - 0.3, chars });
    t += AFTER_CMD;
  } else {
    items.push({ ...s, at: t });
    t += LINE;
  }
}
const END = t + HOLD, TOTAL = END + FADE;
const pct = (s) => ((s / TOTAL) * 100).toFixed(3);
const fadeAt = pct(END);

let css = '';
let k = 0;
const appear = (at) => {
  const name = `a${k++}`;
  css += `@keyframes ${name}{0%,${pct(at)}%{opacity:0}${pct(at + 0.001)}%,${fadeAt}%{opacity:1}100%{opacity:0}}\n`;
  return `style="animation-name:${name}"`;
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let y = TOP + 18;
let body = '';
for (const it of items) {
  if (it.gap) { y += 8; continue; }
  if (it.cmd) {
    body += `<text x="${PAD}" y="${y}" xml:space="preserve"><tspan class="p" ${appear(it.at)}>$ </tspan>`;
    for (const { c, at } of it.chars) body += `<tspan class="c" ${appear(at)}>${esc(c)}</tspan>`;
    body += `</text>\n`;
  } else {
    body += `<text x="${PAD}" y="${y}" xml:space="preserve" ${appear(it.at)}>`;
    if (it.tag) body += `<tspan class="${it.cls}">${esc(it.tag)}</tspan><tspan class="dim">${esc(it.out)}</tspan>`;
    else body += `<tspan class="${it.cls}">${esc(it.out)}</tspan>`;
    body += `</text>\n`;
  }
  y += LH;
}
const H = y + 10;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="figma-vault init, demo and check in a terminal: the chain works without a Figma token">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:${FS}px;fill:#c9d1d9}
text[style],tspan[style]{animation-duration:${TOTAL.toFixed(2)}s;animation-iteration-count:infinite;animation-timing-function:linear;opacity:0}
.p{fill:#7ee787;font-weight:600}.c{fill:#e6edf3;font-weight:600}.dim{fill:#8b949e}
.ok{fill:#3fb950;font-weight:600}.warn{fill:#d29922;font-weight:600}.strong{fill:#e6edf3;font-weight:600}
.title{animation:none;opacity:1;fill:#8b949e;font-size:12px}
@media (prefers-reduced-motion:reduce){text[style],tspan[style]{animation:none;opacity:1}}
${css}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#30363d"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>
<text class="title" x="${W / 2}" y="24" text-anchor="middle">no Figma token needed</text>
<line x1="0" y1="38" x2="${W}" y2="38" stroke="#30363d"/>
${body}</svg>
`;

writeFileSync(new URL('./demo.svg', import.meta.url), svg);
console.log(`demo.svg: ${W}x${H}, ${TOTAL.toFixed(1)} s loop, ${svg.length} bytes`);
