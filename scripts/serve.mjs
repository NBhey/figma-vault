// Дев-сервер для восстановленной вёрстки.
//   npm run dev            → http://localhost:5173
//   npm run dev -- 8080    → другой порт
//
// Каждая восстановленная страница живёт в restored/<имя>/ и описывает свой эталон
// в restored/<имя>/source.json: { title, vault, docId }.
//
//   /                 список страниц
//   /<имя>/           сама страница
//   /compare/<имя>    страница и эталонный рендер Figma рядом, с синхронной прокруткой

import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "restored");
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

const send = (res, code, type, body) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Страницы = подкаталоги restored/ с index.html. source.json необязателен. */
async function pages() {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      await stat(path.join(dir, "index.html"));
    } catch {
      continue;
    }
    let source = {};
    try {
      source = JSON.parse(await readFile(path.join(dir, "source.json"), "utf8"));
    } catch {
      // страница без описания эталона — сравнение для неё недоступно
    }
    found.push({ name: entry.name, title: source.title ?? entry.name, source });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function referenceFor(page) {
  const { vault, docId } = page.source ?? {};
  if (!vault || !docId) return null;
  return path.join(repo, vault, docId, "screenshot.png");
}

function indexPage(list) {
  const rows = list
    .map((p) => {
      const cmp = p.source?.vault
        ? `<a class="btn" href="/compare/${encodeURIComponent(p.name)}">сравнить с макетом</a>`
        : `<span class="muted">эталон не указан в source.json</span>`;
      return `<li>
        <div><a class="name" href="/${encodeURIComponent(p.name)}/">${escape(p.title)}</a>
        <div class="muted">restored/${escape(p.name)}/</div></div>
        ${cmp}
      </li>`;
    })
    .join("");
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Восстановленные макеты</title>
<style>
  body{background:#0d1117;color:#e6edf3;font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;margin:0;padding:48px 24px}
  main{max-width:720px;margin:0 auto}
  h1{font-size:20px;margin:0 0 24px}
  ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
  li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;border:1px solid #2a323d;border-radius:10px}
  .name{color:#e6edf3;font-weight:600;text-decoration:none}
  .name:hover{color:#11D452}
  .muted{color:#8b949e;font-size:13px}
  .btn{background:#11D452;color:#062C1F;font-weight:600;font-size:13px;text-decoration:none;padding:7px 14px;border-radius:7px;white-space:nowrap}
  .empty{color:#8b949e;border:1px dashed #2a323d;border-radius:10px;padding:24px;text-align:center}
  code{background:#161b22;padding:2px 6px;border-radius:4px}
</style></head><body><main>
<h1>Восстановленные макеты</h1>
${list.length ? `<ul>${rows}</ul>` : `<div class="empty">В <code>restored/</code> пока нет страниц.<br>Каждая страница — это каталог <code>restored/&lt;имя&gt;/index.html</code>.</div>`}
</main></body></html>`;
}

function comparePage(page) {
  const name = encodeURIComponent(page.name);
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Сравнение — ${escape(page.title)}</title>
<style>
  :root{--bar:#11151b;--line:#2a323d;--ink:#e6edf3;--muted:#8b949e;--accent:#11D452}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,"Segoe UI",sans-serif;height:100vh;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:20px;padding:10px 16px;background:var(--bar);border-bottom:1px solid var(--line);flex:0 0 auto;flex-wrap:wrap}
  h1{font-size:14px;font-weight:600}
  a.back{color:var(--muted);text-decoration:none}
  a.back:hover{color:var(--ink)}
  label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}
  input[type=range]{width:150px;accent-color:var(--accent)}
  button{background:#21262d;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 12px;font:inherit;cursor:pointer}
  button[aria-pressed=true]{background:var(--accent);color:#062C1F;border-color:var(--accent);font-weight:600}
  main{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);min-height:0}
  section{background:#0d1117;display:flex;flex-direction:column;min-height:0;min-width:0}
  h2{font-size:12px;font-weight:500;color:var(--muted);padding:6px 12px;border-bottom:1px solid var(--line);flex:0 0 auto}
  .pane{flex:1 1 auto;overflow:auto;min-height:0}
  .scaler{width:1280px;transform-origin:top left}
  iframe{width:1280px;height:6000px;border:0;display:block;background:#0d1117}
  .pane img{width:1280px;display:block}
  body.overlay main{grid-template-columns:1fr}
  body.overlay .right{display:none}
  body.overlay .ghost{display:block}
  .ghost{display:none;position:absolute;top:0;left:0;width:1280px;pointer-events:none}
  .stack{position:relative;width:1280px}
</style></head><body>
<header>
  <a class="back" href="/">← все макеты</a>
  <h1>${escape(page.title)}</h1>
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
        <iframe id="frame" src="/${name}/" title="Восстановленная страница"></iframe>
        <img class="ghost" id="ghost" src="/reference/${name}.png" alt="">
      </div>
    </div>
  </section>
  <section class="right">
    <h2>Эталон Figma</h2>
    <div class="pane" id="paneB">
      <div class="scaler"><img src="/reference/${name}.png" alt="Эталонный рендер макета"></div>
    </div>
  </section>
</main>
<script>
  const paneA=document.getElementById('paneA'), paneB=document.getElementById('paneB');
  const zoom=document.getElementById('zoom'), zoomval=document.getElementById('zoomval');
  const mode=document.getElementById('mode'), opacity=document.getElementById('opacity');
  const opval=document.getElementById('opval'), ghost=document.getElementById('ghost');
  const opLabel=document.querySelector('.op'), frame=document.getElementById('frame');

  // Высота iframe подгоняется под реальную высоту восстановленной страницы.
  function fitFrame(){
    try{
      const h=frame.contentDocument?.documentElement?.scrollHeight;
      if(h) frame.style.height=h+'px';
    }catch{}
    applyZoom();
  }
  frame.addEventListener('load',fitFrame);

  function applyZoom(){
    const k=zoom.value/100;
    zoomval.textContent=zoom.value+'%';
    for(const s of document.querySelectorAll('.scaler')){
      s.style.transform='scale('+k+')';
      s.style.height=(s.scrollHeight*k)+'px';
      s.style.width=(1280*k)+'px';
    }
  }
  zoom.addEventListener('input',applyZoom);
  window.addEventListener('load',fitFrame);
  applyZoom();

  let lock=false;
  const sync=(from,to)=>from.addEventListener('scroll',()=>{
    if(lock) return; lock=true;
    to.scrollTop=from.scrollTop; to.scrollLeft=from.scrollLeft;
    requestAnimationFrame(()=>{lock=false;});
  });
  sync(paneA,paneB); sync(paneB,paneA);

  mode.addEventListener('click',()=>{
    const on=mode.getAttribute('aria-pressed')!=='true';
    mode.setAttribute('aria-pressed',String(on));
    document.body.classList.toggle('overlay',on);
    mode.textContent=on?'Рядом':'Наложить';
    opLabel.style.display=on?'flex':'none';
    ghost.style.opacity=opacity.value/100;
  });
  opacity.addEventListener('input',()=>{
    ghost.style.opacity=opacity.value/100;
    opval.textContent=opacity.value+'%';
  });
  ghost.style.opacity=0.5;
</script></body></html>`;
}

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    // Битый %-код бросает исключение, а необработанный reject в обработчике роняет процесс.
    return send(res, 400, "text/plain", "bad request");
  }
  const list = await pages();

  if (pathname === "/") return send(res, 200, types[".html"], indexPage(list));

  if (pathname.startsWith("/compare/")) {
    const name = pathname.slice("/compare/".length).replace(/\/$/, "");
    const page = list.find((p) => p.name === name);
    if (!page) return send(res, 404, types[".html"], `<h1>404</h1><p>нет страницы ${escape(name)}</p>`);
    return send(res, 200, types[".html"], comparePage(page));
  }

  if (pathname.startsWith("/reference/")) {
    const name = pathname.slice("/reference/".length).replace(/\.png$/, "");
    const page = list.find((p) => p.name === name);
    const file = page ? await referenceFor(page) : null;
    if (!file) {
      return send(res, 404, types[".html"], `эталон для ${escape(name)} не описан в source.json`);
    }
    try {
      return send(res, 200, types[".png"], await readFile(file));
    } catch {
      return send(res, 404, types[".html"], `screenshot.png не найден для ${escape(name)}`);
    }
  }

  const rel = pathname.replace(/^\/+/, "");
  const file = path.resolve(root, rel.endsWith("/") || rel === "" ? `${rel}index.html` : rel);
  // Не startsWith: он пропускает соседей вроде restored-secret, а на Windows до них
  // добираются через %5c.
  const inside = path.relative(root, file);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    return send(res, 403, "text/plain", "forbidden");
  }

  try {
    const info = await stat(file);
    const target = info.isDirectory() ? path.join(file, "index.html") : file;
    const type = types[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    return send(res, 200, type, await readFile(target));
  } catch {
    return send(res, 404, types[".html"], `<h1>404</h1><p>${escape(rel)}</p><p><a href="/">к списку</a></p>`);
  }
});

// Только localhost: сервер отдаёт файлы репозитория, в локальную сеть ему незачем.
server.listen(port, "127.0.0.1", () => {
  console.log("");
  console.log("  Список макетов  http://localhost:" + port + "/");
  console.log("");
  console.log("  Ctrl+C — остановить");
});
