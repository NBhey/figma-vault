/**
 * Скрипт, который агент выполняет в браузере своего проекта, чтобы снять снимок DOM
 * для `figma-vault verify`. Браузер в пакет не входит: подойдёт Playwright проекта,
 * DevTools или браузерный инструмент агента. Формат снимка знает только этот файл.
 *
 * Корень свёрстанного макета помечается `data-figma-node-id="<source.nodeId>"`,
 * отдельные блоки — тем же атрибутом с id узла. Координаты в снимке — от левого верхнего
 * угла корня, как `layout` в doc.json. Без помеченного корня геометрию сверить не с чем.
 */
export function snapshotScript(rootNodeId: string): string {
  return `(() => {
  const rootId = ${JSON.stringify(rootNodeId)};
  const root = document.querySelector('[data-figma-node-id="' + CSS.escape(rootId) + '"]');
  const scope = root || document.body;
  const base = scope.getBoundingClientRect();
  const round = (n) => Math.round(n * 100) / 100;

  const isShown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const blockOf = (el) => {
    while (el !== scope && el.parentElement && getComputedStyle(el).display === "inline") el = el.parentElement;
    return el;
  };

  // Текст одного блока собирается из его строчных потомков: <b>, <span> с цветом внутри
  // абзаца не дробят его на куски — как фрагменты text.runs не дробят узел Figma.
  const byBlock = new Map();
  // <br> — перевод строки, как \\n в text.content; без этого многострочный текст не совпадёт.
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const isBreak = node.nodeType === 1 && node.tagName === "BR";
    if (node.nodeType === 1 && !isBreak) continue;
    if (!isBreak && !node.data.trim()) continue;
    const parent = node.parentElement;
    if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) continue;
    if (!isShown(parent)) continue;
    const block = blockOf(parent);
    if (isBreak && !byBlock.has(block)) continue;
    byBlock.set(block, (byBlock.get(block) || "") + (isBreak ? "\\n" : node.data));
  }

  const nodes = [];
  const marked = [...(root ? [root] : []), ...scope.querySelectorAll("[data-figma-node-id]")];
  for (const el of marked) {
    if (!isShown(el)) continue;
    const r = el.getBoundingClientRect();
    nodes.push({
      id: el.getAttribute("data-figma-node-id"),
      x: round(r.left - base.left), y: round(r.top - base.top),
      w: round(r.width), h: round(r.height),
    });
  }

  return JSON.stringify({
    schema: "figma-vault/snapshot@0",
    root: root ? rootId : null,
    viewport: { w: innerWidth, h: innerHeight },
    texts: [...byBlock.values()],
    nodes,
  });
})()`;
}
