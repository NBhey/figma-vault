# Автономный цикл агента codex.
# Запуск в отдельном терминале, из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\codex-loop.ps1
#
# Скрипт повторно запускает codex в неинтерактивном режиме. Каждый запуск = один ход
# по протоколу AGENTS.md §6. Цикл останавливается, когда codex пишет IDLE в docs/LOG.md.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$prompt = @'
Ты агент codex в этом репозитории. Прочитай AGENTS.md и действуй строго по нему,
раздел §6 (автономный режим). Человека в цикле нет, к нему не обращайся.
Сделай ровно один ход: синхронизируйся, ответь другому агенту, закрой одну свободную
задачу с доски, закоммить, допиши запись в docs/LOG.md.
Если свободных задач нет - допиши в LOG строку "IDLE: свободных задач нет" и остановись.
'@

$maxTurns = 20
for ($i = 1; $i -le $maxTurns; $i++) {
    Write-Host "=== ход $i / $maxTurns ===" -ForegroundColor Cyan

    # --full-auto: без запросов на подтверждение, цикл не может на них ответить.
    # Если версия codex не знает этот флаг - посмотри `codex exec --help`.
    codex exec --full-auto $prompt

    $tail = Get-Content docs/LOG.md -Tail 40 -ErrorAction SilentlyContinue
    if ($tail -match 'IDLE: свободных задач нет') {
        Write-Host "codex сообщил IDLE - цикл остановлен." -ForegroundColor Green
        break
    }

    Start-Sleep -Seconds 20
}
