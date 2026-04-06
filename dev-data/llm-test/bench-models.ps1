$ErrorActionPreference = "Stop"

Write-Host "bench-models.ps1 remains available for multi-model sweeps. For the normal Ryzen/Qwen benchmark, use dev-data/llm-test/bench.ps1."

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

$models = @(
  @{
    Label = "qwen2.5-7b-q8"
    ModelFile = "/models/hf-cache/hub/models--bartowski--Qwen2.5-7B-Instruct-GGUF/snapshots/8911e8a47f92bac19d6f5c64a2e2095bd2f7d031/Qwen2.5-7B-Instruct-Q8_0.gguf"
  },
  @{
    Label = "qwen3-8b-q4"
    ModelFile = "/models/Qwen3-8B-Q4_K_M.gguf"
  },
  @{
    Label = "qwen3.5-9b-q6"
    ModelFile = "/models/Qwen3.5-9B-Q6_K.gguf"
  },
  @{
    Label = "mistral-small-24b-q4"
    ModelFile = "/models/hf-cache/hub/models--bartowski--Mistral-Small-24B-Instruct-2501-GGUF/snapshots/62a613c92d5a5f73bba6d348b51433b232c4640c/Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf"
  },
  @{
    Label = "qwen3-30b-a3b-q4"
    ModelFile = "/models/hf-cache/hub/models--unsloth--Qwen3-30B-A3B-GGUF/snapshots/d5b1d57bd0b504ac62ae6c725904e96ef228dc74/Qwen3-30B-A3B-Q4_K_M.gguf"
  }
)

function Wait-LlamaReady {
  param(
    [int]$TimeoutSeconds = 600
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health -TimeoutSec 5
      if ($health.Content -match '"status":"ok"') {
        return
      }
    } catch {
      Start-Sleep -Seconds 3
    }
  }

  throw "Timed out waiting for llama.cpp to become healthy."
}

foreach ($model in $models) {
  Write-Host ""
  Write-Host "=== $($model.Label) ==="

  $env:LLAMA_MODEL_FILE = $model.ModelFile
  $env:LLAMA_MODEL_ALIAS = $model.Label
  $env:LLAMA_REASONING = "off"

  podman --connection podman-machine-default compose up -d --force-recreate llama | Out-Host
  Wait-LlamaReady

  $env:LLM_ENDPOINT = "http://127.0.0.1:8081"
  $env:LLM_TIMEOUT = "20m"
  $env:BENCH_MODEL_LABEL = $model.Label
  $env:LLM_DEFAULT_TEMPERATURE = "0"
  $env:LLM_DEFAULT_TOP_P = "1"
  $env:LLM_DEFAULT_MAX_TOKENS = "8192"
  bun run dev-data/llm-test/run-llm-offline-benchmark.ts --label=$($model.Label)
}
