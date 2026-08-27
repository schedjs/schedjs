# Contributing to sched

Thanks for considering a contribution! This page covers the legal bits and the
development workflow. For product questions see the [docs](docs/content/docs/01.introduction.md).

## Contributor License Agreement (CLA)

Before your **first** pull request is merged, you must sign a Contributor
License Agreement — Apache-style **ICLA** (individual) or **CALA** (corporate).
This is what lets the project keep dual-licensing the codebase (MIT core +
commercial tier) without asking for re-approval later.

The CLA is managed through [CLA-assistant](https://cla-assistant.io) — the bot
will post a link on your first PR. Signing is a one-time step: it covers all
future contributions.

## Trademark notice

**`sched`** and the sched logo are project trademarks and are **not** granted
under the MIT license. You may use them to refer to the project (e.g. "built
with sched"), but not to promote derivative works, products, or services in a
way that implies endorsement.

## Development setup

Requirements: Node.js `>= 22.5` (the core package uses `node:sqlite`), yarn 4.

```bash
yarn install        # monorepo: packages/* + apps/* + docs
yarn build          # tsc build of all packages
yarn test           # vitest suite
yarn typecheck      # tsc --noEmit
```

The monorepo layout:

- `packages/*` — published libraries (`@schedjs/core`, `@schedjs/daemon`, `@schedjs/admin-api`, `@schedjs/cli`, `@schedjs/mcp`, `@schedjs/ui`, `@schedjs/storage-*`)
- `apps/*` — runnables built from the packages (e.g. `apps/daemon`)
- `docs/` — Docus 5 documentation site (`docs/content/docs/` are the markdown sources)

## Pull request flow

1. **TDD by default** — a code change ships with its tests (red → green → refactor).
2. Keep commits conventional (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
3. `yarn test` and `yarn typecheck` must pass.
4. If the change touches the public surface (a package export, CLI flag, env var,
   daemon option, runner, storage adapter, `tasks.json` field, or a changed default),
   update the docs in the same PR.
5. First PR? Expect the CLA bot. Everything else: a human maintainer reviews.
