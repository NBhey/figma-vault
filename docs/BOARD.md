# Доска задач

Статусы: `free` → `wip` → `done` / `blocked`.
Захват — по правилам `AGENTS.md` §2. Правь только строку своей задачи.

| id | задача | владеет (файлы) | owner | claimed (UTC) | статус |
|---|---|---|---|---|---|
| T0 | Протокол: AGENTS.md, BOARD.md, LOG.md, CONTRACT.md | корень, docs | claude | 2026-09-22T14:27Z | done |
| T1 | Каркас: package.json, tsconfig, .gitignore, npm-скрипты `pull` и `mcp` | корень | claude | 2026-09-22T14:30Z | done |
| T2 | Фикстура `vault/example/` — рукописный doc.json по контракту + 2 ассета | `vault/example/**` | claude | 2026-09-22T14:30Z | done |
| T3 | Экспортёр: Figma REST → нормализация → запись в vault. CLI `pull <figma-url>` | `src/pull/**` | codex | 2026-09-22T14:44Z | done |
| T4 | MCP-сервер stdio: 6 инструментов из контракта, читает только vault | `src/mcp/**` | claude | 2026-09-22T14:30Z | done |
| T5 | Валидатор doc.json против контракта, общий для обеих сторон | `src/shared/**` | codex | 2026-09-22T14:59Z | done |
| T6 | Проверка качества: по фикстуре агент восстанавливает HTML, сверка со `screenshot.png` | `docs/QUALITY.md` | codex | 2026-09-22T15:06Z | done |
| T7 | README: как выгрузить макет и подключить MCP к Claude Code и Codex | `README.md` | codex | 2026-09-22T15:03Z | done |
| T8 | Обработка 429 и Retry-After в FigmaClient: подождать и повторить вместо падения | `src/pull/**` | codex → claude (§7) | 2026-09-22T18:05:06Z | done |
| T9 | Выводить токены из фактического использования, когда в файле нет shared styles | `src/pull/**` | codex | 2026-09-22T16:45Z | done |
| T10 | doc@1: `text.runs` — цветные фрагменты внутри текстового узла | `src/pull/**`, `src/shared/**` | codex | 2026-09-23T05:45:21Z | done |
| T11 | doc@1: градиентные заливки в `style.fill` | `src/pull/**`, `src/shared/**` | claude (зона codex, §7) | 2026-09-22T19:10Z | done |
| T15 | Иконки из fillGeometry вместо рендера через /v1/images — главный источник расхода лимита | `src/pull/**` | codex | 2026-09-22T17:44:14Z | done |
| T12 | Пакет и единый CLI: init, add, list, mcp; переносимый .mcp.json; слэш-команда /figma | `src/cli/**`, корень | claude | 2026-09-22T18:05Z | done |
| T13 | Инструкция по раздаче команде и подключению к рабочему проекту | `docs/INTEGRATION.md` | claude | 2026-09-22T18:05Z | done |
| T14 | Команды demo и check: проверка цепочки без токена Figma | `src/cli/**` | claude | 2026-09-22T18:30Z | done |
| T16 | Подготовка к публикации в npm: README на английском, LICENSE, чистый tarball, поля пакета | корень, `README*.md` | claude | 2026-09-23T05:11Z | done |
| T17 | MCP под doc@1: `includeHidden` в чтении (скрытые узлы по умолчанию не отдаются), типы `hidden`/`text.runs`, приём doc@0 и doc@1 | `src/mcp/**` | claude | 2026-09-23T05:44Z | done |
| T18 | Релиз 0.1.1: версия, README под doc@1, версия MCP-сервера из package.json, проверка tarball | корень, `README*.md`, `src/mcp/server.ts` | claude | 2026-09-23T05:53Z | done |
| T20 | CLI сверки: `figma-vault verify` + `--snippet` для снимка DOM, шаг в `/figma` | `src/cli/**` | claude | 2026-09-23T05:55Z | done |
| T19 | Автоматическая структурная сверка: ядро без браузерной зависимости и QA на реальном макете | `src/pull/**`, `docs/QUALITY.md` | codex | 2026-09-23T05:54:33Z | done |
| T21 | Английские пользовательские предупреждения экспортёра Figma | `src/pull/**` | codex | 2026-09-23T06:19Z | wip |

## Зависимости

- T2 разблокирует T3 и T4: обе стороны работают против фикстуры, без токена Figma.
- T3 и T4 полностью независимы друг от друга, связаны только через `docs/CONTRACT.md`.
- T6 имеет смысл только после T4.
- T5 может делать любой, полезен обоим.

## Рекомендуемый порядок для codex

T3 (это самая объёмная часть, и она свободна) → T5 → T7.
Если T3 уже занят — бери T5, затем T6.
