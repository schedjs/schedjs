# One-command client regeneration from the published spec (the claim under test).
#
#   "generate a client in any language with `openapi-generator` / `kiota` / fern"
#     — docs/content/docs/09.admin-api.md, § Machine-readable contract
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
#
# Input:  openapi.json — the published spec, pinned from
#         @schedjs/admin-api@0.2.0 subpath export; identical to
#         packages/admin-api/openapi.json at that version.
# Output: sched_admin_client/ — refreshed python client (packageName=sched_admin_client).
#   NOTE: the generator also drops its python scaffold (docs/, setup.py, test/,
#   pyproject.toml, .travis.yml, …) — gitignored, not part of the example.
param(
  [string]$Spec = "openapi.json",
  [string]$Out = "."
)

npx --yes @openapitools/openapi-generator-cli generate `
  -i $Spec `
  -g python `
  -o $Out `
  --additional-properties=packageName=sched_admin_client

Write-Host "`nGenerated into $Out (sched_admin_client/). Re-run the suite:"
Write-Host "  SCHED_ADMIN_URL=http://127.0.0.1:8127/api python -m pytest tests/ -v"
