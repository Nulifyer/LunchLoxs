$ErrorActionPreference = "Stop"

Write-Host "bench-suite.ps1 is now a thin wrapper. Use dev-data/llm-test/bench.ps1 going forward."
& (Join-Path $PSScriptRoot "bench.ps1") @args
