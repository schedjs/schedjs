# admin-client-ts — TypeScript client from `@schedjs/admin-api` OpenAPI

Second verified flavor of the docs' claim *"generate a client in any language
with `openapi-generator` / `kiota` / fern"* — after Python
(`examples/admin-client-python`, full suite 24/24 + smoke 19/19).

Here the bar is **compile-clean under `tsc --strict`** (no runtime fixtures):

```
tsc --noEmit  →  exit 0
```

| | |
|---|---|
| Generator | `openapi-generator` 7.24.0, `typescript-axios` |
| Input spec | `openapi.json` — pinned `@schedjs/admin-api/openapi.json`, **0.2.0** subpath export (byte-identical to the repo copy; guarded by `packages/admin-api/test/ts-client-guard.test.ts`) |
| Output | `client/` — typed API classes + models (`api.ts` etc.) |
| Nullable 3.1 | `type: ["string","null"]` → `string \| null` — verified |

## Why a second flavor

Round 1 of the F&F admin-client cycle found generator-facing spec bugs
(`const:true` → string enum, `oneOf+discriminator` → `actual_instance=None`) —
**Python-generator** quirks. One generator passing proves nothing about the
other ~50. The spec uses OpenAPI 3.1 nullable unions (21 occurrences of
`type: [...,"null"]`), whose support varies by flavor — TypeScript was the
highest-value probe: `books` Phase 3 (Nuxt 4) is the only real consumer.

## Verify

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-25.0.2.10-hotspot"
$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
.\generate.ps1        # regen client/ from openapi.json
npm install           # axios + typescript
npx tsc --noEmit      # must exit 0
```

## Guard

`packages/admin-api/test/ts-client-guard.test.ts`:
- **always-on**: the pinned `openapi.json` copies in both examples are
  byte-identical to `packages/admin-api/openapi.json` — a spec edit that
  forgets to re-pin + regenerate fails the suite.
- **opt-in** (`RUN_TS_SMOKE=1`): fresh `openapi-generator` (typescript-axios)
  run + `tsc --noEmit` on the output — the full generation guard for CI
  (needs JDK 11+; skipped when `java` is unavailable).
