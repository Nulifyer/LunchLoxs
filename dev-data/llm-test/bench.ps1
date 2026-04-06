param(
  [string[]]$Group = @(),
  [string[]]$Slug = @(),
  [switch]$SkipReport
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

$suitePath = Join-Path $root "dev-data\llm-test\benchmark-suite.json"
$resultsRoot = Join-Path $root "dev-data\llm-test\results\suite\qwen3-8b-q4"
New-Item -ItemType Directory -Force -Path $resultsRoot | Out-Null

$cases = @(Get-Content $suitePath -Raw | ConvertFrom-Json)

if ($Group.Count -gt 0) {
  $cases = @($cases | Where-Object {
    $caseGroups = @($_.groups)
    @($Group | Where-Object { $caseGroups -contains $_ }).Count -gt 0
  })
}

if ($Slug.Count -gt 0) {
  $wantedSlugs = @($Slug | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
  $cases = @($cases | Where-Object { $wantedSlugs -contains $_.slug.ToLowerInvariant() })
}

if ($cases.Count -eq 0) {
  throw "No benchmark cases matched the requested filters."
}

$env:LLM_ENDPOINT = "http://127.0.0.1:8081"
$env:BROWSERLESS_ENDPOINT = "http://127.0.0.1:3000"
$env:BROWSERLESS_TOKEN = "dev-token"
$env:LLM_TIMEOUT = "20m"
$env:LLM_PASS0_ENABLE_THINKING = "true"
$env:LLM_PASS1_ENABLE_THINKING = "false"
$env:LLM_PASS2_ENABLE_THINKING = "false"
$env:LLM_PASS3_ENABLE_THINKING = "false"

Write-Host ""
Write-Host "Benchmarking qwen3-8b-q4 on the local Ryzen AI setup..."
Write-Host "Cases: $($cases.Count)"
if ($Group.Count -gt 0) {
  Write-Host "Groups: $($Group -join ', ')"
}
if ($Slug.Count -gt 0) {
  Write-Host "Slugs: $($Slug -join ', ')"
}

foreach ($case in $cases) {
  Write-Host ""
  Write-Host "=== $($case.label) ==="

  bun run dev-data/llm-test/run-llm-extraction-test.ts $case.url | Out-Host

  $dest = Join-Path $resultsRoot $case.slug
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  foreach ($f in '00-raw.html','00-jsonld.json','01-input.txt','02-raw-extract.txt','02-extract.txt','03-extract.txt','04-process.txt','05-tag.txt','06-final.json') {
    $src = Join-Path $root ("dev-data\llm-test\" + $f)
    if (Test-Path $src) {
      Copy-Item $src $dest -Force
    }
  }
}

if (-not $SkipReport) {
  & (Join-Path $root "dev-data\llm-test\build-suite-report.ps1")
}

Write-Host ""
Write-Host "Suite results saved under:"
Write-Host "  $resultsRoot"
