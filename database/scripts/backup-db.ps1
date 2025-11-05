param([string]$OutDir = (Join-Path $PSScriptRoot 'db_backups'))

. "$PSScriptRoot\db-env.ps1"

try {
  if (-not $env:PGURL) { throw "PGURL env var not set. Put it in .env.local" }
  if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    throw "pg_dump not found in PATH. Install Postgres client tools."
  }

  $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $dest = Join-Path $OutDir "backup_$timestamp.dump"
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  pg_dump `
    --format=custom `
    --no-owner `
    --no-privileges `
    --verbose `
    --schema=public `
    --file "$dest" $env:PGURL

  Write-Host "Backup written to $dest"
}
catch {
  Write-Host "`nERROR:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($_.InvocationInfo.PositionMessage) { Write-Host "`nAt:`n$($_.InvocationInfo.PositionMessage)" }
  Write-Host "`nTip: run 'Get-Command pg_dump' and 'echo `$env:PGURL' to verify tools & env."
  Read-Host "`nPress Enter to close"
  exit 1
}
