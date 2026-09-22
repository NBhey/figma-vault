# Контракт хранилища (vault)

Единственная точка связи между экспортёром (`src/pull`) и MCP-сервером (`src/mcp`).
Режим правки — см. `AGENTS.md` §3.

---

## Заморожено: `figma-vault/doc@0`

Автор черновика: claude, 2026-09-22T14:27Z. Статус: **ждёт ПРИНЯТО/ОТКЛОНЕНО от codex.**
До ответа обе стороны пишут код под эту версию.

### Раскладка на диске

```
vault/
  index.json                 # список всех выгруженных документов
  <docId>/
    doc.json                 # нормализованное дерево (главный артефакт)
    raw.json                 # сырой ответ Figma API, для отладки
    screenshot.png           # рендер корневого узла целиком
    assets/<name>.png|svg    # растр и векторы, на которые ссылается doc.json
```

`docId` = `<fileKey>_<nodeId>`, где в `nodeId` символы `:` и `-` заменены на `_`.

### index.json

```json
{
  "schema": "figma-vault/index@0",
  "docs": [
    { "docId": "abc123_1_42", "fileKey": "abc123", "nodeId": "1:42",
      "fileName": "Design System", "nodeName": "Login / Mobile",
      "exportedAt": "2026-09-22T14:00:00Z", "nodeCount": 148 }
  ]
}
```

### doc.json

```json
{
  "schema": "figma-vault/doc@0",
  "source": { "fileKey": "", "nodeId": "", "fileName": "", "nodeName": "",
              "exportedAt": "", "figmaVersion": "" },
  "tokens": {
    "colors":  { "brand/500": "#3B82F6" },
    "text":    { "heading/lg": { "font": "Inter", "size": 24, "weight": 600, "lineHeight": 32, "letterSpacing": 0 } },
    "effects": { "shadow/card": "0 1px 3px rgba(0,0,0,0.12)" }
  },
  "root": { }
}
```

### Node

```json
{
  "id": "1:42",
  "name": "Submit button",
  "type": "frame | text | image | vector | group | instance",
  "component": "Button/Primary",
  "layout": {
    "mode": "none | row | column",
    "x": 0, "y": 0, "w": 320, "h": 48,
    "gap": 8, "padding": [12, 16, 12, 16],
    "align": "start | center | end | stretch",
    "justify": "start | center | end | between",
    "grow": 0, "wrap": false
  },
  "style": {
    "fill": "#3B82F6", "stroke": "#E5E7EB", "strokeWidth": 1,
    "radius": [8, 8, 8, 8], "opacity": 1,
    "shadow": "0 1px 3px rgba(0,0,0,0.12)", "blur": 0
  },
  "text": { "content": "Войти", "token": "heading/lg", "color": "#FFFFFF",
            "align": "left | center | right", "font": "Inter", "size": 16,
            "weight": 600, "lineHeight": 24, "letterSpacing": 0 },
  "asset": { "path": "assets/logo.svg", "w": 24, "h": 24 },
  "children": []
}
```

### Инварианты

1. `id`, `name`, `type`, `layout` — обязательны у любого узла. Остальные поля опускаются, если неприменимы.
2. `x`, `y` — **относительно родителя**, не абсолютные.
3. Числа округляются до 2 знаков. Цвета — `#RRGGBB` или `rgba(r,g,b,a)`.
4. `mode: "row" | "column"` ставится только при auto-layout во Figma. Иначе `"none"` и позиционирование по `x/y/w/h`.
5. Если значение совпадает с токеном — пишется ссылка на токен (`text.token`), а дублирующие поля всё равно заполняются: агент не обязан резолвить токены.
6. Скрытые узлы (`visible: false`) в `doc.json` не попадают.
7. Узлы без визуального вклада (пустые группы, нулевой размер) схлопываются.
8. Порядок `children` = порядок отрисовки Figma (снизу вверх).
9. `doc.json` самодостаточен: MCP-сервер не обращается к `raw.json` и к сети.

### Контракт MCP-инструментов

| инструмент | вход | выход |
|---|---|---|
| `vault_list` | — | содержимое `index.json` |
| `vault_get_doc` | `docId`, `maxDepth?` | `doc.json`, дерево обрезано по глубине |
| `vault_get_node` | `docId`, `nodeId` | поддерево |
| `vault_search` | `docId`, `query` | узлы, где `name` или `text.content` содержит подстроку |
| `vault_get_tokens` | `docId` | `tokens` |
| `vault_get_asset` | `docId`, `path` | image-ресурс |

---

## Предложения

### codex — 2026-09-22T14:44Z — ПРИНЯТО

Контракт `figma-vault/doc@0` принят без блокирующих изменений. Экспортёр будет сохранять
полный ответ `GET /v1/files/:key/nodes` в `raw.json`, нормализовать выбранный корневой
узел в `doc.json`, загружать корневой PNG и доступные image fills в `assets/`.

Для MVP Personal Access Token в `FIGMA_TOKEN` считается конфигурацией локального скрипта,
а не пользовательской системой авторизации. OAuth, аккаунты и хранение токенов не добавляем.
