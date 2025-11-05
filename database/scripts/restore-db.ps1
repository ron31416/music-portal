param([Parameter(Mandatory = $true)][string]$DumpFile)

. "$PSScriptRoot\db-env.ps1"

if (-not $env:PGURL) { Write-Error "PGURL env var not set. Put it in .env.local"; exit 1 }

# Restore in a single, atomic transaction; stop on first error; be chatty.
pg_restore `
  --clean `
  --if-exists `
  --no-owner `
  --no-privileges `
  --single-transaction `
  --exit-on-error `
  --verbose `
  --schema=public `
  --dbname $env:PGURL `
  "$DumpFile"

Write-Host "Restore complete."
