# llama.cpp server for LLM-enhanced recipe extraction.
#
# For development: model is mounted from dev-data/models/ via docker-compose.
# For production: build with a model baked in, or mount a volume.
#
# Recommended model: Qwen3.5-9B-Q8_0 (~9.5GB, needs ~12GB VRAM)
# Download: https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q8_0.gguf
#
# For GPU (NVIDIA): use server-cuda13 image + --gpu-layers 99
# For CPU only: use server image (slower, ~5 tok/s vs ~80 tok/s on GPU)
#
# Any OpenAI-compatible endpoint works as an alternative (Ollama, vLLM, remote API).

FROM ghcr.io/ggml-org/llama.cpp:server-cuda13

EXPOSE 8080

ENTRYPOINT ["/app/llama-server"]
CMD ["--model", "/models/model.gguf", "--host", "0.0.0.0", "--port", "8080", "--jinja", "--ctx-size", "32768", "--n-predict", "16384", "--threads", "12", "--gpu-layers", "99", "--reasoning-budget", "8192", "--reasoning-format", "deepseek"]
