$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$outDir = Join-Path $root "dev-data\llm-test\results\control-report"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Load-Json {
  param([string]$Path)
  if (!(Test-Path $Path)) { return $null }
  try {
    return Get-Content $Path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Count-Tags {
  param([string]$Path)
  if (!(Test-Path $Path)) { return 0 }
  $content = Get-Content $Path -Raw
  return ([regex]::Matches($content, '@\[')).Count
}

function Read-Text {
  param([string]$Path)
  if (!(Test-Path $Path)) { return "" }
  return Get-Content $Path -Raw
}

function Score-Case {
  param(
    $Json,
    [int]$TagCount,
    [string]$Bucket,
    [string]$RawExtract
  )

  if ($Bucket -eq "broken") {
    if ($RawExtract -match 'No recipe found' -or $RawExtract -match 'not a recipe') {
      return @{ Score = 2; Verdict = "correctly_rejected"; Notes = "Broken page rejected instead of hallucinated" }
    }

    if ($null -eq $Json) {
      return @{ Score = 1; Verdict = "weak"; Notes = "No final JSON parsed, but rejection was not explicit" }
    }

    return @{ Score = 0; Verdict = "fail"; Notes = "Broken page produced recipe-like output" }
  }

  if ($null -eq $Json) {
    return @{ Score = 0; Verdict = "fail"; Notes = "No final JSON parsed" }
  }

  $score = 0
  $notes = @()

  if ($Json.title) { $score += 1 } else { $notes += "missing title" }
  if ($Json.ingredients.Count -ge 5) { $score += 1 } else { $notes += "too few ingredients" }
  if ($Json.instructions -and $Json.instructions.Length -ge 120) { $score += 1 } else { $notes += "thin instructions" }

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

  return @{
    Score = $score
    Verdict = $verdict
    Notes = ($notes -join "; ")
  }
}

$cases = @(
  @{
    Bucket = "jsonld"
    Name = "Tomato Egg Drop Soup"
    Path = Join-Path $root "dev-data\llm-test\results\live-controls-pass0think\qwen3-8b-q4\woks-tomato-egg-drop-soup"
    Url = "https://thewoksoflife.com/tomato-egg-drop-soup/"
  },
  @{
    Bucket = "jsonld"
    Name = "Easy Homemade Lasagna"
    Path = Join-Path $root "dev-data\llm-test\results\live-controls-pass0think\qwen3-8b-q4\spendwithpennies-lasagna"
    Url = "https://www.spendwithpennies.com/easy-homemade-lasagna/"
  },
  @{
    Bucket = "raw"
    Name = "Kadai Vegetables"
    Path = Join-Path $root "dev-data\llm-test\results\live-controls-rawreal\qwen3-8b-q4\vegetarian-kadai-vegetables"
    Url = "https://vegetarian-planet.blogspot.com/2009/08/kadai-vegetables.html"
  },
  @{
    Bucket = "raw"
    Name = "Double Chocolate Banana Muffins"
    Path = Join-Path $root "dev-data\llm-test\results\live-controls-rawreal\qwen3-8b-q4\vegetarian-double-chocolate-banana-muffins"
    Url = "https://vegetarian-planet.blogspot.com/2009/12/eggless-and-butterless-double-chocolate.html"
  },
  @{
    Bucket = "raw"
    Name = "Mutton Korma/Kuruma"
    Path = Join-Path $root "dev-data\llm-test\results\live-controls-rawreal\qwen3-8b-q4\shabs-mutton-korma"
    Url = "https://shabscuisine.blogspot.com/2009/11/mutton-kormakuruma-mild-and-creamy.html"
  },
  @{
    Bucket = "broken"
    Name = "King Arthur 404"
    Path = Join-Path $root "dev-data\llm-test\results\live-controls-pass0think\qwen3-8b-q4\king-arthur-sourdough-pancakes"
    Url = "https://www.kingarthurbaking.com/recipes/classic-sourdough-pancakes-or-waffles-recipe"
  }
)

$results = foreach ($case in $cases) {
  $jsonPath = Join-Path $case.Path "06-final.json"
  $json = Load-Json $jsonPath
  $tagPath = Join-Path $case.Path "05-tag.txt"
  $rawExtractPath = Join-Path $case.Path "02-raw-extract.txt"
  $tagCount = Count-Tags $tagPath
  $rawExtract = Read-Text $rawExtractPath
  $score = Score-Case -Json $json -TagCount $tagCount -Bucket $case.Bucket -RawExtract $rawExtract
  $input = Read-Text (Join-Path $case.Path "01-input.txt")

  [pscustomobject]@{
    Bucket = $case.Bucket
    Name = $case.Name
    Url = $case.Url
    Title = if ($json) { $json.title } else { "" }
    Ingredients = if ($json) { $json.ingredients.Count } else { 0 }
    Images = if ($json) { $json.imageUrls.Count } else { 0 }
    Tags = $tagCount
    Score = $score.Score
    Verdict = $score.Verdict
    Notes = $score.Notes
    InputChars = $input.Length
    RawExtractChars = $rawExtract.Length
  }
}

$grouped = $results | Group-Object Bucket

$lines = @(
  "# Control Report",
  "",
  "Generated: $(Get-Date -Format s)",
  "",
  "This report scores current control cases for the tuned Qwen3-8B setup.",
  ""
)

foreach ($group in $grouped) {
  $lines += "## $($group.Name.ToUpperInvariant())"
  $lines += ""
  foreach ($item in $group.Group) {
    $lines += "- $($item.Name): $($item.Verdict) (score $($item.Score)) | ingredients=$($item.Ingredients) | tags=$($item.Tags) | images=$($item.Images) | input_chars=$($item.InputChars) | raw_extract_chars=$($item.RawExtractChars)"
    $lines += "  URL: $($item.Url)"
    if ($item.Title) {
      $lines += "  Title: $($item.Title)"
    }
    if ($item.Notes) {
      $lines += "  Notes: $($item.Notes)"
    }
  }
  $lines += ""
}

$summaryRows = $results | Group-Object Bucket | ForEach-Object {
  $strong = @($_.Group | Where-Object Verdict -eq "strong").Count
  $usable = @($_.Group | Where-Object Verdict -eq "usable").Count
  $weak = @($_.Group | Where-Object Verdict -eq "weak").Count
  $fail = @($_.Group | Where-Object Verdict -eq "fail").Count
  $correctlyRejected = @($_.Group | Where-Object Verdict -eq "correctly_rejected").Count
  [pscustomobject]@{
    Bucket = $_.Name
    Strong = $strong
    Usable = $usable
    Weak = $weak
    Fail = $fail
    CorrectlyRejected = $correctlyRejected
    AvgScore = [math]::Round((($_.Group | Measure-Object Score -Average).Average), 2)
  }
}

$lines += "## Bucket Summary"
$lines += ""
foreach ($row in $summaryRows) {
  $lines += "- $($row.Bucket): avg_score=$($row.AvgScore), strong=$($row.Strong), usable=$($row.Usable), weak=$($row.Weak), fail=$($row.Fail), correctly_rejected=$($row.CorrectlyRejected)"
}

$reportPath = Join-Path $outDir "qwen3-8b-q4-control-report.md"
$jsonPath = Join-Path $outDir "qwen3-8b-q4-control-report.json"

$lines -join "`n" | Set-Content -Path $reportPath
$results | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath

Write-Host "Wrote:"
Write-Host "  $reportPath"
Write-Host "  $jsonPath"
