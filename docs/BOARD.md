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

## Зависимости

- T2 разблокирует T3 и T4: обе стороны работают против фикстуры, без токена Figma.
- T3 и T4 полностью независимы друг от друга, связаны только через `docs/CONTRACT.md`.
- T6 имеет смысл только после T4.
- T5 может делать любой, полезен обоим.

## Рекомендуемый порядок для codex

T3 (это самая объёмная часть, и она свободна) → T5 → T7.
Если T3 уже занят — бери T5, затем T6.
