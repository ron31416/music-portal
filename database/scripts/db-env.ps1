# Loads env vars from repo-root .env.local (works when pasted or run as a script)

# determine repo root:
# - when run as a .ps1, $PSScriptRoot is set; go up 2 dirs (scripts -> database -> repo)
# - when pasted, fall back to current location
if ($PSScriptRoot) {
  $repoRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
} else {
  $repoRoot = (Get-Location).Path
}

$envPath = Join-Path $repoRoot ".env.local"
if (-not (Test-Path $envPath)) {
  Write-Error ".env.local not found at $envPath"
  exit 1
}

Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*$') { return }
  $k, $v = $_ -split '=', 2
  $v = $v.Trim('"').Trim("'")
  Set-Item -Path ("Env:{0}" -f $k) -Value $v
}

Write-Host "loaded environment from $envPath"
Write-Host "PGURL present: " -NoNewline; if ($env:PGURL) { Write-Host "yes" } else { Write-Host "no" }
