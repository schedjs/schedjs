# One-command client regeneration from the published spec (the claim under test).

#   "generate a client in any language with `openapi-generator` / `kiota` / fern"
#     — docs/content/docs/09.admin-api.md, § Machine-readable contract
#
# This is the SECOND verified flavor (TypeScript / typescript-axios). The first
# was Python (examples/admin-client-python) — suite 24/24 + smoke 19/19. Here we
# prove the spec also generates a client that compiles clean under `tsc --strict`
# (no runtime fixtures — compile-clean is the bar).
#
# Prereqs:
#   - npx (node) — pulls @openapitools/openapi-generator-cli
#   - JDK 11+ for the generator JVM. On this machine Java 8 is the PATH default,
#     so point JAVA_HOME at a newer JDK (e.g. Temurin 25) AND put its bin on
#     PATH before running (the CLI spawns `java` from PATH).
#
# Usage (from this folder):
#   $env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-25.0.2.10-hotspot"
#   $env:Path = "$env:JAVA_HOME\bin;" + $env:Path
#   .\generate.ps1
#   npm install   # axios + typescript (dev)
#   npx tsc --noEmit   # must exit 0
#
# Input:  openapi.json — the published spec, pinned from
#         @schedjs/admin-api@0.2.0 subpath export; byte-identical to
#         packages/admin-api/openapi.json (guarded by packages/admin-api/test/
#         ts-client-guard.test.ts).
# Output: client/ — refreshed typescript-axios client (api.ts + support files).
#   The generator also drops its scaffold (docs/, .gitignore, .npmignore,
#   git_push.sh, .openapi-generator/) — removed by this script, not committed.

param(
  [string]$Spec = "openapi.json",
  [string]$Out = "client"
)

npx --yes @openapitools/openapi-generator-cli generate `
  -i $Spec `
  -g typescript-axios `
  -o $Out

# strip the generator scaffold — only the client code is part of the example
Remove-Item -Recurse -Force "$Out\docs", "$Out\.openapi-generator", `
  "$Out\git_push.sh", "$Out\.gitignore", "$Out\.npmignore", `
  "$Out\.openapi-generator-ignore" -ErrorAction SilentlyContinue

Write-Host "`nGenerated into $Out/. Verify compile-clean:"
Write-Host "  npm install && npx tsc --noEmit"
