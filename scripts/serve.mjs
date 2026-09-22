// Дев-сервер для восстановленной вёрстки.
//   npm run dev            → http://localhost:5173
//   npm run dev -- 8080    → другой порт
//
// Отдаёт restored/ как статику, плюс два служебных адреса:
//   /reference.png  — эталонный рендер из vault
//   /compare        — восстановленная страница и эталон рядом, со синхронной прокруткой

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "restored");
const vaultDir = path.join(repo, process.env.VAULT_DIR ?? "vault/real");

// docId берётся из index.json, чтобы сервер пережил следующую выгрузку.
async function referencePath() {
  const index = JSON.parse(await readFile(path.join(vaultDir, "index.json"), "utf8"));
  const docId = index.docs?.[0]?.docId;
  if (!docId) throw new Error("в index.json нет документов");
  return path.join(vaultDir, docId, "screenshot.png");
}
const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const comparePage = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Сравнение с макетом</title>
<style>
  :root{--bar:#11151b;--line:#2a323d;--ink:#e6edf3;--muted:#8b949e;--accent:#11D452}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,"Segoe UI",sans-serif;height:100vh;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:20px;padding:10px 16px;background:var(--bar);border-bottom:1px solid var(--line);flex:0 0 auto;flex-wrap:wrap}
  h1{font-size:14px;font-weight:600}
  label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}
  input[type=range]{width:160px;accent-color:var(--accent)}
  button{background:#21262d;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 12px;font:inherit;cursor:pointer}
  button[aria-pressed=true]{background:var(--accent);color:#062C1F;border-color:var(--accent);font-weight:600}
  main{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);min-height:0}
  section{background:#0d1117;display:flex;flex-direction:column;min-height:0;min-width:0}
  h2{font-size:12px;font-weight:500;color:var(--muted);padding:6px 12px;border-bottom:1px solid var(--line);flex:0 0 auto}
  .pane{flex:1 1 auto;overflow:auto;min-height:0}
  .scaler{width:1280px;transform-origin:top left}
  iframe{width:1280px;height:4100px;border:0;display:block;background:#062C1F}
  .pane img{width:1280px;display:block}
  body.overlay main{grid-template-columns:1fr}
  body.overlay .right{display:none}
  body.overlay .ghost{display:block}
  .ghost{display:none;position:absolute;top:0;left:0;width:1280px;pointer-events:none}
  .stack{position:relative;width:1280px}
</style>
</head>
<body>
<header>
  <h1>restored/index.html <span style="color:var(--muted);font-weight:400">против</span> screenshot.png</h1>
  <button id="mode" aria-pressed="false">Наложить</button>
  <label class="op" style="display:none">прозрачность эталона
    <input type="range" id="opacity" min="0" max="100" value="50">
    <span id="opval" style="width:34px;text-align:right">50%</span>
  </label>
  <label>масштаб
    <input type="range" id="zoom" min="25" max="100" value="50">
    <span id="zoomval" style="width:34px;text-align:right">50%</span>
  </label>
  <span style="color:var(--muted);margin-left:auto">прокрутка синхронная</span>
</header>
<main>
  <section class="left">
    <h2>Восстановлено из vault</h2>
    <div class="pane" id="paneA">
      <div class="scaler stack">
        <iframe id="frame" src="/index.html" title="Восстановленная страница"></iframe>
        <img class="ghost" id="ghost" src="/reference.png" alt="">
      </div>
    </div>
  </section>
  <section class="right">
    <h2>Эталон Figma</h2>
    <div class="pane" id="paneB">
      <div class="scaler"><img src="/reference.png" alt="Эталонный рендер макета"></div>
    </div>
  </section>
</main>
<script>
  const paneA = document.getElementById('paneA');
  const paneB = document.getElementById('paneB');
  const zoom = document.getElementById('zoom');
  const zoomval = document.getElementById('zoomval');
  const mode = document.getElementById('mode');
  const opacity = document.getElementById('opacity');
  const opval = document.getElementById('opval');
  const ghost = document.getElementById('ghost');
  const opLabel = document.querySelector('.op');

  function applyZoom() {
    const k = zoom.value / 100;
    zoomval.textContent = zoom.value + '%';
    for (const s of document.querySelectorAll('.scaler')) {
      s.style.transform = 'scale(' + k + ')';
      const h = s.scrollHeight || 4100;
      s.style.height = (h * k) + 'px';
      s.style.width = (1280 * k) + 'px';
    }
  }
  zoom.addEventListener('input', applyZoom);
  window.addEventListener('load', applyZoom);
  applyZoom();

  let lock = false;
  const sync = (from, to) => from.addEventListener('scroll', () => {
    if (lock) return;
    lock = true;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => { lock = false; });
  });
  sync(paneA, paneB);
  sync(paneB, paneA);

  mode.addEventListener('click', () => {
    const on = mode.getAttribute('aria-pressed') !== 'true';
    mode.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('overlay', on);
    mode.textContent = on ? 'Рядом' : 'Наложить';
    opLabel.style.display = on ? 'flex' : 'none';
    ghost.style.opacity = opacity.value / 100;
  });
  opacity.addEventListener('input', () => {
    ghost.style.opacity = opacity.value / 100;
    opval.textContent = opacity.value + '%';
  });
  ghost.style.opacity = 0.5;
</script>
</body>
</html>`;

const send = (res, code, type, body) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/compare") return send(res, 200, types[".html"], comparePage);

  if (pathname === "/reference.png") {
    try {
      return send(res, 200, types[".png"], await readFile(await referencePath()));
    } catch {
      return send(res, 404, types[".html"], "screenshot.png не найден в " + vaultDir);
    }
  }

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(root, rel);
  if (!file.startsWith(root)) return send(res, 403, "text/plain", "forbidden");

  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error("dir");
    const type = types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return send(res, 200, type, await readFile(file));
  } catch {
    return send(res, 404, types[".html"], `<h1>404</h1><p>${rel}</p><p><a href="/">на главную</a></p>`);
  }
});

server.listen(port, () => {
  console.log("");
  console.log("  Восстановленная вёрстка  http://localhost:" + port + "/");
  console.log("  Сравнение с макетом      http://localhost:" + port + "/compare");
  console.log("");
  console.log("  Ctrl+C — остановить");
});
