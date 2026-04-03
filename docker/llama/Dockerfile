# llama.cpp server for LLM-enhanced recipe extraction.
#
# For development: model is mounted from dev-data/models/ via docker-compose.
# For production: build with a model baked in, or mount a volume.
#
# Recommended model: Qwen3-8B-Q4_K_M (~5GB, needs ~6GB RAM)
# Download: https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
#
# Any OpenAI-compatible endpoint works as an alternative (Ollama, vLLM, remote API).

FROM ghcr.io/ggml-org/llama.cpp:server

EXPOSE 8080

ENTRYPOINT ["/app/llama-server"]
CMD ["--model", "/models/model.gguf", "--host", "0.0.0.0", "--port", "8080", "--ctx-size", "8192", "--n-predict", "4096", "--threads", "8"]
