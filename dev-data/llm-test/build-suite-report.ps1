$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$suitePath = Join-Path $root "dev-data\llm-test\benchmark-suite.json"
$resultsRoot = Join-Path $root "dev-data\llm-test\results\suite\qwen3-8b-q4"
$outDir = Join-Path $root "dev-data\llm-test\results\suite-report"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Load-JsonMaybe {
  param([string]$Path)
  if (!(Test-Path $Path)) { return $null }
  try { return Get-Content $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Read-Text {
  param([string]$Path)
  if (!(Test-Path $Path)) { return "" }
  return Get-Content $Path -Raw
}

function Count-Tags {
  param([string]$Path)
  if (!(Test-Path $Path)) { return 0 }
  return ([regex]::Matches((Get-Content $Path -Raw), '@\[')).Count
}

function Get-Verdict {
  param(
    $Final,
    [int]$TagCount,
    [string]$RawExtract,
    [string[]]$Groups
  )

  if ($Groups -contains "control_broken") {
    if ($RawExtract -match 'No recipe found' -or $RawExtract -match 'not a recipe') {
      return @{ verdict = "correctly_rejected"; score = 2; notes = "Broken page rejected instead of hallucinated" }
    }
    if ($null -eq $Final) {
      return @{ verdict = "weak"; score = 1; notes = "No final JSON parsed, but rejection was not explicit" }
    }
    return @{ verdict = "fail"; score = 0; notes = "Broken page produced recipe-like output" }
  }

  if ($null -eq $Final) {
    return @{ verdict = "fail"; score = 0; notes = "No final JSON parsed" }
  }

  $score = 0
  $notes = @()

  if ($Final.title) { $score += 1 } else { $notes += "missing title" }
  if ($Final.ingredients.Count -ge 5) { $score += 1 } else { $notes += "too few ingredients" }
  if ($Final.instructions -and $Final.instructions.Length -ge 120) { $score += 1 } else { $notes += "thin instructions" }

  if ($TagCount -ge 3) {
    $score += 1
  } elseif ($TagCount -ge 1) {
    $notes += "low ingredient tag coverage"
  } else {
    $notes += "no ingredient tags"
  }

  $verdict = switch ($score) {
    { $_ -ge 4 } { "strong"; break }
    3 { "usable"; break }
    2 { "weak"; break }
    default { "fail" }
  }

  return @{ verdict = $verdict; score = $score; notes = ($notes -join "; ") }
}

$cases = Get-Content $suitePath -Raw | ConvertFrom-Json

$rows = foreach ($case in $cases) {
  $dir = Join-Path $resultsRoot $case.slug
  $final = Load-JsonMaybe (Join-Path $dir "06-final.json")
  $rawExtract = Read-Text (Join-Path $dir "02-raw-extract.txt")
  $input = Read-Text (Join-Path $dir "01-input.txt")
  $tagCount = Count-Tags (Join-Path $dir "05-tag.txt")
  $eval = Get-Verdict -Final $final -TagCount $tagCount -RawExtract $rawExtract -Groups $case.groups

  [pscustomobject]@{
    label = $case.label
    slug = $case.slug
    url = $case.url
    groups = @($case.groups)
    title = if ($final) { $final.title } else { "" }
    ingredients = if ($final) { $final.ingredients.Count } else { 0 }
    images = if ($final) { $final.imageUrls.Count } else { 0 }
    tags = $tagCount
    input_chars = $input.Length
    raw_extract_chars = $rawExtract.Length
    parsed = [bool]$final
    verdict = $eval.verdict
    score = $eval.score
    notes = $eval.notes
  }
}

$jsonPath = Join-Path $outDir "qwen3-8b-q4-suite-report.json"
$mdPath = Join-Path $outDir "qwen3-8b-q4-suite-report.md"

$rows | ConvertTo-Json -Depth 6 | Set-Content $jsonPath

$lines = @(
  "# Benchmark Suite Report",
  "",
  "Generated: $(Get-Date -Format s)",
  "",
  "This report combines known examples from text-recipes.md and the control cases.",
  ""
)

$detailGroups = @("known", "control")
foreach ($group in $detailGroups) {
  $items = @($rows | Where-Object { $_.groups -contains $group })
  if ($items.Count -eq 0) { continue }
  $lines += "## $($group.ToUpperInvariant())"
  $lines += ""
  foreach ($item in $items) {
    $lines += "- $($item.label): $($item.verdict) (score $($item.score)) | parsed=$($item.parsed) | ingredients=$($item.ingredients) | tags=$($item.tags) | images=$($item.images) | input_chars=$($item.input_chars) | raw_extract_chars=$($item.raw_extract_chars)"
    $lines += "  URL: $($item.url)"
    if ($item.title) {
      $lines += "  Title: $($item.title)"
    }
    if ($item.notes) {
      $lines += "  Notes: $($item.notes)"
    }
  }
  $lines += ""
}

$lines += "## Summary"
$lines += ""
$summaryGroups = @("known", "control", "control_jsonld", "control_raw", "control_broken")
foreach ($group in $summaryGroups) {
  $items = @($rows | Where-Object { $_.groups -contains $group })
  if ($items.Count -eq 0) { continue }
  $avgScore = [math]::Round((($items | Measure-Object score -Average).Average), 2)
  $strong = @($items | Where-Object verdict -eq "strong").Count
  $usable = @($items | Where-Object verdict -eq "usable").Count
  $weak = @($items | Where-Object verdict -eq "weak").Count
  $fail = @($items | Where-Object verdict -eq "fail").Count
  $correctlyRejected = @($items | Where-Object verdict -eq "correctly_rejected").Count
  $lines += "- ${group}: avg_score=$avgScore, strong=$strong, usable=$usable, weak=$weak, fail=$fail, correctly_rejected=$correctlyRejected"
}

$lines -join "`n" | Set-Content $mdPath

Write-Host "Wrote:"
Write-Host "  $jsonPath"
Write-Host "  $mdPath"
