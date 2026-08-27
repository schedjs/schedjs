# Admin UI

> Four ways to consume the sched admin UI — standalone, embedded at a path, components, or your own on the admin api

The admin UI ships as **@schedjs/ui** — Lit web components (framework-agnostic:
plain HTML, Vue, React, Svelte) plus a standalone shell. It talks to the
[admin api](admin-api) (`createAdminApi` from `@schedjs/admin-api`), which the daemon
mounts at `/api/*` and embedded apps can mount at any path. The shell page
footer shows the `@schedjs/ui` version, the daemon version (fetched from
`/health`), the admin-api mount and a GitHub link.

Four consumption modes:

<table>
<thead>
  <tr>
    <th>
      Mode
    </th>
    
    <th>
      How
    </th>
    
    <th>
      When
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      1. <strong>
        Standalone
      </strong>
    </td>
    
    <td>
      <code>
        sched-ui serve --proxy http://127.0.0.1:8080
      </code>
    </td>
    
    <td>
      a UI next to a daemon in one command
    </td>
  </tr>
  
  <tr>
    <td>
      2. <strong>
        Embedded at a path
      </strong>
    </td>
    
    <td>
      host <code>
        dist/
      </code>
      
       statically under <code>
        /sched
      </code>
      
      , <code>
        ?api=/sched/api
      </code>
    </td>
    
    <td>
      mount the UI inside your app
    </td>
  </tr>
  
  <tr>
    <td>
      3. <strong>
        Components
      </strong>
    </td>
    
    <td>
      <code>
        <sched-runs base="/api" token="…">
      </code>
      
       in your page
    </td>
    
    <td>
      build the UI into your own markup
    </td>
  </tr>
  
  <tr>
    <td>
      4. <strong>
        Custom UI
      </strong>
    </td>
    
    <td>
      <code>
        createAdminApi
      </code>
      
       from <code>
        @schedjs/admin-api
      </code>
    </td>
    
    <td>
      your own panel, CLI, or client
    </td>
  </tr>
</tbody>
</table>

## 1. Standalone

```bash
npm i -g @schedjs/ui        # or: npx @schedjs/ui
sched-ui serve --proxy http://127.0.0.1:8080 --port 8081
```

Open **http://127.0.0.1:8081**. `/api/*` is proxied to the daemon on the same
origin — no CORS setup, and the Bearer token never leaves the browser→sched-ui hop.

> **Cache control.** The bundle (`/sched-ui.bundle.js`) is served with
> `Cache-Control: no-store` and `/api/*` proxy responses with `no-cache` — a
> rebuilt UI or a fresh run snapshot is never served stale from the browser cache.

## 2. Embedded at a path

Host the built `dist/` of `@schedjs/ui` under any path (nginx, CDN, your app's static
folder) and point it at your admin api mount:

- `dist/index.html` is the shell — open `https://you.example/sched/`
- query overrides: `?api=…`, `?token=…`, `?refresh=…` (e.g. `?api=/sched/api`)

## 3. Components

```html
<script type="module" src="/sched-ui.bundle.js"></script>
<sched-runs base="/api" token="…" limit="50"></sched-runs>
<sched-tasks base="/api"></sched-tasks>
<sched-schedules base="/api"></sched-schedules>
```

Components are Lit custom elements — they work in any framework. Theming is via CSS
custom properties (`--sched-bg`, `--sched-card`, `--sched-line`, `--sched-text`,
`--sched-muted`, `--sched-ok`, `--sched-bad`, `--sched-run`): override them in your
own stylesheet to match your brand.

Run deletion in `<sched-runs>` is two-step: the row's **del** button arms to **sure?**
and only a second click within 3s deletes (auto-disarms on timeout or refresh) — a
stray click can't wipe a run.

**Auto-refresh** — every list (`<sched-runs>`, `<sched-tasks>`, `<sched-schedules>`)
polls the admin api on the `refreshMs` interval (property, or the `refresh-ms`
attribute; default 5000 ms) so live fields — run status/progress, next-run and
last-run times, fail counts — stay current; set `refreshMs=0` to disable polling.
The shell sets this from the `?refresh=…` query override.

**Last status** — `<sched-schedules>` and `<sched-tasks>` show a `last status`
column (✔ succeeded / ✘ failed / ⊘ cancelled) so you can see how the most recent
run ended at a glance. The value comes from the server (`lastRunStatus` in
`GET /schedules` / `GET /tasks`), resolved in one pass — the browser does not
fetch the run per row.

**Schedules are first-class** (schedule-as-entity) — `<sched-schedules>` lists each
schedule row: `task`, rule, `tz`, **data** (the per-tenant parameters), next run,
last run + status, and the **effective pause status**: 🔴 `paused (task)` when the
family stop holds the schedule, 🟡 `paused (schedule)` when only this instance is
paused, ▶ `active`. The two levels are shown separately so «снял паузу, а оно
молчит» never happens — `resume` on a schedule held by the task still shows 🔴
until `resume` is called on the task.

**Runtime rows** — a schedule whose task is runtime-only (`fileManaged=false`, e.g.
created via the API, not `tasks.json`) shows a `runtime` badge next to the task name.
File-managed rows (from `tasks.json`) have no badge.

**Manage schedules** — the `+ new` button opens a form (task picker from `GET /tasks`, kind cron/interval/once + value, tz, data JSON, externalId, dedupKey,
retry JSON, priority); it POSTs `/schedules` (a `dedupKey` makes the second save an
upsert, not a duplicate). Each row has **pause / resume**, **edit** (`PATCH /schedules/:id` — the rule/tz/data/policy change in place, `nextRunAt` recomputes
on a rule change) and **delete** with a confirm (runs are kept — the audit
survives).

**Pagination** — every list (`<sched-runs>`, `<sched-tasks>`, `<sched-schedules>`) has a
footer: `‹ prev` / page-size select (10/25/50/100) / row range / `next ›`. Lists are
fetched with `limit + 1` rows to detect whether a next page exists (the probe row is
trimmed), so **next** is disabled on the last page and **prev** on the first. Changing
the page size resets to the first page. Page size defaults to 50 (set the `limit`
attribute); the current page offset is the `offset` attribute — set both to start the
list elsewhere.

## 4. Custom UI

`createAdminApi` exposes the same REST surface the components use — health, runs,
tasks, schedules, plus trigger / pause / resume / delete. See [Admin API](admin-api).

## Auth (SCHED_ADMIN_KEY)

With a key set on the daemon, the shell prompts for it in the header (saved to
localStorage) — or pass `?token=…` on the URL, or set `el.token` on components.

## Embedded apps (no daemon)

An embedded engine can mount the admin api itself and use any UI mode:

```ts
import { createEngine, createInternalRunner, createSqliteStorage } from '@schedjs/core';
import { createAdminApi } from '@schedjs/admin-api';

const engine = createEngine({ /* … */ });
const admin = createAdminApi({ engine, storage, auth: { apiKey: '…' } });

// in your http server, mount /sched/api → admin.handleRequest(req, res)
```

Then point the shell at it with `?api=/sched/api` (mode 2), or drop components into
your page (mode 3).
