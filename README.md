# Figma Vault

Локальный снимок выбранного Figma-макета для AI-агентов. Макет читается из Figma один раз,
нормализуется и сохраняется на диске; после этого Claude Code, Codex и другие MCP-клиенты
работают с локальным vault без повторных обращений к Figma.

```text
Figma URL → pull CLI → vault/<docId>/ → stdio MCP → AI-агент
```

Это персональный MVP: без SaaS, базы данных, OAuth, real-time sync и редактирования макета.

## Что уже работает

- экспорт одного выбранного Figma-узла и всего его поддерева;
- нормализация auto-layout, координат, стилей, текста, компонентов и токенов;
- локальные `doc.json`, `raw.json`, `screenshot.png` и PNG/SVG-ассеты;
- строгая проверка формата `figma-vault/doc@0`;
- MCP-сервер с шестью read-only инструментами;
- тестовая фикстура, для которой не нужен доступ к Figma.

Требования: Node.js 22+, Claude Code и/или Codex CLI. На Windows команды ниже выполняются
из PowerShell в корне репозитория. Если политика PowerShell блокирует `npm.ps1`, используйте
`npm.cmd` вместо `npm`.

## Установка и проверка

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Для проверки MCP без Figma:

```powershell
npm.cmd run mcp:example
```

Процесс будет ждать JSON-RPC на stdin — для stdio MCP это нормальное поведение.

## Выгрузка макета

1. Создайте в Figma Personal Access Token со scope `file_content:read`.
2. Скопируйте URL конкретного Frame/узла. В URL обязательно должен быть `node-id`.
3. Передайте токен только через переменную окружения и запустите экспорт:

```powershell
$env:FIGMA_TOKEN = "figd_..."
npm.cmd run pull -- "https://www.figma.com/design/FILE_KEY/Name?node-id=1-42"
Remove-Item Env:FIGMA_TOKEN
```

Результат появится в `vault/<FILE_KEY>_<NODE_ID>/`, а документ — в `vault/index.json`.
Повторный экспорт того же узла обновляет запись с тем же `docId`.

Токен не записывается в vault или логи. Реальные выгрузки из `vault/` исключены из Git;
в репозиторий попадает только `vault/example/`.

## Подключение MCP

Сначала соберите проект:

```powershell
npm.cmd run build
```

### Claude Code

```powershell
claude mcp add --scope project figma-vault -- node "C:\Study\figma\dist\mcp\index.js" --vault "C:\Study\figma\vault"
claude mcp get figma-vault
```

### Codex CLI

Standalone CLI должен быть авторизован один раз:

```powershell
codex login
codex mcp add figma-vault -- node "C:\Study\figma\dist\mcp\index.js" --vault "C:\Study\figma\vault"
codex mcp get figma-vault
```

Для тестовой фикстуры замените последний путь на `C:\Study\figma\vault\example`.
При переносе репозитория укажите его новый абсолютный путь.

## Как агент читает макет

Обычно достаточно дать агенту инструкцию:

> Используй MCP `figma-vault`. Найди нужный экран через `vault_list`, сначала запроси
> неглубокое дерево, затем нужные поддеревья и screenshot. Реализуй интерфейс и сравни
> результат с эталонным изображением.

Доступные инструменты:

| инструмент | назначение |
|---|---|
| `vault_list` | список локальных снимков |
| `vault_get_doc` | документ целиком или дерево до `maxDepth` |
| `vault_get_node` | конкретное поддерево по node id |
| `vault_search` | поиск по имени слоя и тексту |
| `vault_get_tokens` | цвета, типографика и эффекты |
| `vault_get_asset` | PNG/SVG-ассет или `screenshot.png` |

MCP-сервер после экспорта не использует сеть и не читает `raw.json`.

## Совместная работа Claude и Codex

Правила координации находятся в `AGENTS.md`, состояние задач — в `docs/BOARD.md`, решения —
в `docs/CONTRACT.md`, handoff — в `docs/LOG.md`. Поэтому человек не пересылает сообщения:
каждый агент читает общий Git-репозиторий, берёт свободную задачу и оставляет результат другому.

Перед автономными запусками авторизуйте обе CLI. Codex-цикл запускается так:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\codex-loop.ps1
```

Claude запускается в этом же каталоге и получает инструкцию `продолжай автономный цикл по
AGENTS.md §6`. Два процесса можно оставить работать параллельно; писать в одни и те же исходные
файлы им запрещает таблица владения в `AGENTS.md`.

## Ограничения MVP

- нужен однократный Figma Personal Access Token;
- экспортируется выбранный узел, а не весь рабочий процесс Figma;
- градиенты, сложные blend modes, прототипирование и анимация не нормализуются полностью;
- при неудачном рендере отдельного ассета snapshot сохраняется с предупреждением;
- визуальную точность всё равно нужно проверять по `screenshot.png`.

