# sched example workers (polyglot)

HTTP-воркеры на 4 языках, реализующие контракт runner protocol
(`docs/content/docs/05.protocol.md`) **с нуля** — без SDK и без внешних
зависимостей (только стандартная библиотека). Любой язык, который умеет
HTTP + JSON, пишет воркера за ~50–150 строк, скопировав один из этих примеров.

| Язык | Файл | Запуск | Порт по умолчанию |
|---|---|---|---|
| Go | `go/worker.go` | `cd go && go run .` | 8080 |
| Python | `python/worker.py` | `cd python && python3 worker.py` (Windows: `py worker.py`) | 8081 |
| C# | `csharp/Program.cs` | `cd csharp && dotnet run` | 8082 |
| Java | `java/Worker.java` | `cd java && javac Worker.java && java Worker` | 8083 |

## Контракт задач

| Задача | Поведение |
|---|---|
| `ping` | sync: `200 {status:"succeeded", result:{...}}`; `data.fail=true` → `200 {status:"failed", error}` |
| `long` | async: `202 {status:"accepted", statusUrl, pollIntervalMs}` → GET `statusUrl` → `running` с прогрессом → терминальный конверт |
| любое другое имя | обрабатывается как sync (echo: имя задачи + data в result) |

Поля `data`:

- `workMs` — длительность «работы» в мс (по умолчанию: sync 100 / async 150; async
  делает 5 шагов прогресса по `workMs` — итого ~750 мс на длинный таск)
- `fail` — `true` → принудительный фейл (нужен для conformance-сценария sync-fail)

## Auth (опционально)

Env `SCHED_API_KEY` — задан → каждый запрос (dispatch И poll) требует заголовок
`x-sched-api-key` с совпадающим значением, иначе `401 {"error":"unauthorized"}`.
Не задан → валидация пропущена, воркер работает «из коробки».

```bash
# пример с auth (Linux/macOS; в PowerShell: $env:SCHED_API_KEY="secret")
SCHED_API_KEY=secret go run .   # теперь только с x-sched-api-key: secret
```

## Окружение

| Env | Назначение |
|---|---|
| `SCHED_PORT` | Порт (переопределяет дефолт из таблицы выше) |
| `SCHED_BASE_URL` | Базовый URL для `statusUrl` в async-ответе. По умолчанию выводится из `Host` запроса. Задавайте, когда демон обращается к воркеру по адресу, отличному от того, что воркер видит в `Host` (NAT, прокси, контейнер) |

## Idempotency

Каждый воркер хранит состояние по `x-sched-run-id` (in-memory map + мьютекс):
повторная доставка того же run-id отвечает сохранённым результатом вместо
повторного выполнения — это сторона идемпотентности воркера из протокола.

## Валидация (curl)

Сценарии 1–3 дизайна (sync ✓, sync fail, async lifecycle). Подставьте порт из
таблицы выше. Запустите воркер, затем:

```bash
# 1. Sync success: ping → 200 {status:"succeeded"}
curl -s -X POST http://127.0.0.1:8080/ \
  -H 'content-type: application/json' \
  -H 'x-sched-run-id: test-1' \
  -d '{"task":{"name":"ping","config":{}},"data":{}}'

# 2. Sync failure: data.fail=true → 200 {status:"failed", error}
curl -s -X POST http://127.0.0.1:8080/ \
  -H 'content-type: application/json' \
  -H 'x-sched-run-id: test-2' \
  -d '{"task":{"name":"ping","config":{}},"data":{"fail":true}}'

# 3. Async lifecycle: accepted → poll statusUrl → running → succeeded
curl -s -X POST http://127.0.0.1:8080/ \
  -H 'content-type: application/json' \
  -H 'x-sched-run-id: test-3' \
  -d '{"task":{"name":"long","config":{}},"data":{"workMs":200}}'
# → 202 {"status":"accepted","statusUrl":"http://127.0.0.1:8080/status/test-3","pollIntervalMs":500}
curl -s http://127.0.0.1:8080/status/test-3   # running с прогрессом…
# → через ~1 с: 200 {"status":"succeeded","progress":100,"result":{...}}
```

Дополнительно можно проверить auth и идемпотентность:

```bash
# Auth: без ключа → 401 (только при заданном SCHED_API_KEY)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/ -H 'content-type: application/json' -d '{"task":{"name":"ping","config":{}},"data":{}}'
curl -s -X POST http://127.0.0.1:8080/ -H 'content-type: application/json' -H 'x-sched-api-key: secret' -H 'x-sched-run-id: test-1' -d '{"task":{"name":"ping","config":{}},"data":{}}'

# Idempotency: повторная доставка того же run-id → тот же результат
curl -s -X POST http://127.0.0.1:8080/ -H 'content-type: application/json' -H 'x-sched-run-id: test-1' -d '{"task":{"name":"ping","config":{}},"data":{}}'
```

> Conformance-валидатор `sched check-worker <url>` (6 wire-сценариев, exit 0/1/2)
> поставляется в `@schedjs/cli` — появится после релиза cli-слайса. До этого —
> ручная валидация curl'ом выше.
