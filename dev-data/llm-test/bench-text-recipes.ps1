$ErrorActionPreference = "Stop"

Write-Host "bench-text-recipes.ps1 is now a thin wrapper. Use dev-data/llm-test/bench.ps1 -Group known going forward."
& (Join-Path $PSScriptRoot "bench.ps1") -Group known @args
