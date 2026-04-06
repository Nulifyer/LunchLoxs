package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNormalizeChatCompletionsURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "base url", in: "http://localhost:8080", want: "http://localhost:8080/v1/chat/completions"},
		{name: "full path", in: "http://localhost:8080/v1/chat/completions", want: "http://localhost:8080/v1/chat/completions"},
		{name: "trailing slash", in: "http://localhost:8080/", want: "http://localhost:8080/v1/chat/completions"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeChatCompletionsURL(tc.in); got != tc.want {
				t.Fatalf("normalizeChatCompletionsURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestLoadLLMConfigFromEnvPrecedence(t *testing.T) {
	t.Setenv("LLM_DEFAULT_TEMPERATURE", "0.5")
	t.Setenv("LLM_DEFAULT_TOP_P", "0.9")
	t.Setenv("LLM_DEFAULT_MAX_TOKENS", "4000")
	t.Setenv("LLM_PASS2_TEMPERATURE", "0.2")
	t.Setenv("LLM_PASS3_MAX_TOKENS", "12000")
	t.Setenv("LLM_TIMEOUT", "90s")

	cfg := loadLLMConfigFromEnv()

	if cfg.Timeout != 90*time.Second {
		t.Fatalf("timeout = %s, want 90s", cfg.Timeout)
	}
	if got := cfg.Tuning[llmPassExtract].Temperature; got != 0.5 {
		t.Fatalf("pass1 temperature = %v, want 0.5", got)
	}
	if got := cfg.Tuning[llmPassExtract].TopP; got != 0.9 {
		t.Fatalf("pass1 top_p = %v, want 0.9", got)
	}
	if got := cfg.Tuning[llmPassExtract].MaxTokens; got != 4000 {
		t.Fatalf("pass1 max_tokens = %d, want 4000", got)
	}
	if got := cfg.Tuning[llmPassProcess].Temperature; got != 0.2 {
		t.Fatalf("pass2 temperature = %v, want 0.2", got)
	}
	if got := cfg.Tuning[llmPassTag].MaxTokens; got != 12000 {
		t.Fatalf("pass3 max_tokens = %d, want 12000", got)
	}
}

func TestLoadLLMPromptsFromOverrideDir(t *testing.T) {
	dir := t.TempDir()
	writePromptFixture(t, dir, "pass0-raw-extract.txt", "raw")
	writePromptFixture(t, dir, "pass1-extract.txt", "extract")
	writePromptFixture(t, dir, "pass2-process.txt", "process")
	writePromptFixture(t, dir, "pass3-tag.txt", "tag")

	prompts, err := loadLLMPrompts(dir)
	if err != nil {
		t.Fatalf("loadLLMPrompts error = %v", err)
	}

	if prompts.RawExtract != "raw" || prompts.Extract != "extract" || prompts.Process != "process" || prompts.Tag != "tag" {
		t.Fatalf("unexpected prompts loaded: %#v", prompts)
	}
}

func TestLLMClientCallBuildsGenericRequestAndAuthHeader(t *testing.T) {
	dir := t.TempDir()
	writePromptFixture(t, dir, "pass0-raw-extract.txt", "raw")
	writePromptFixture(t, dir, "pass1-extract.txt", "extract")
	writePromptFixture(t, dir, "pass2-process.txt", "process")
	writePromptFixture(t, dir, "pass3-tag.txt", "tag")

	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"choices\":[{\"message\":{\"content\":\"```text\\nTITLE: Test\\n```\"}}]}"))
	}))
	defer srv.Close()

	client, err := newLLMClient(llmConfig{
		CompletionsURL: normalizeChatCompletionsURL(srv.URL),
		APIKey:         "secret",
		Timeout:        time.Second,
		PromptDir:      dir,
		Tuning: map[llmPass]llmTuning{
			llmPassRawExtract: {Temperature: 0.1, TopP: 0.2, MaxTokens: 300},
		},
	})
	if err != nil {
		t.Fatalf("newLLMClient error = %v", err)
	}

	content, err := client.call(context.Background(), llmPassRawExtract, "sys", "user")
	if err != nil {
		t.Fatalf("call error = %v", err)
	}

	if gotAuth != "Bearer secret" {
		t.Fatalf("authorization header = %q, want bearer", gotAuth)
	}
	if content != "TITLE: Test" {
		t.Fatalf("content = %q, want stripped fenced content", content)
	}
	if _, ok := gotBody["top_k"]; ok {
		t.Fatalf("request unexpectedly included top_k")
	}
	if _, ok := gotBody["chat_template_kwargs"]; ok {
		t.Fatalf("request unexpectedly included chat_template_kwargs")
	}
	if _, ok := gotBody["model"]; ok {
		t.Fatalf("request unexpectedly included model")
	}
	if gotBody["temperature"] != 0.1 {
		t.Fatalf("temperature = %v, want 0.1", gotBody["temperature"])
	}
	if gotBody["top_p"] != 0.2 {
		t.Fatalf("top_p = %v, want 0.2", gotBody["top_p"])
	}
	if int(gotBody["max_tokens"].(float64)) != 300 {
		t.Fatalf("max_tokens = %v, want 300", gotBody["max_tokens"])
	}
}

func TestLLMClientSupportsStructuredContentArray(t *testing.T) {
	dir := t.TempDir()
	writePromptFixture(t, dir, "pass0-raw-extract.txt", "raw")
	writePromptFixture(t, dir, "pass1-extract.txt", "extract")
	writePromptFixture(t, dir, "pass2-process.txt", "process")
	writePromptFixture(t, dir, "pass3-tag.txt", "tag")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":[{"type":"text","text":"TITLE: Test"}]}}]}`))
	}))
	defer srv.Close()

	client, err := newLLMClient(llmConfig{
		CompletionsURL: normalizeChatCompletionsURL(srv.URL),
		Timeout:        time.Second,
		PromptDir:      dir,
		Tuning: map[llmPass]llmTuning{
			llmPassExtract: {Temperature: 0.1, TopP: 0.2, MaxTokens: 300},
		},
	})
	if err != nil {
		t.Fatalf("newLLMClient error = %v", err)
	}

	content, err := client.call(context.Background(), llmPassExtract, "sys", "user")
	if err != nil {
		t.Fatalf("call error = %v", err)
	}
	if content != "TITLE: Test" {
		t.Fatalf("content = %q, want TITLE: Test", content)
	}
}

func TestResolvePromptDirFallsBackToRepoPrompts(t *testing.T) {
	dir, err := resolvePromptDir("")
	if err != nil {
		t.Fatalf("resolvePromptDir error = %v", err)
	}
	if !strings.HasSuffix(filepath.ToSlash(dir), "prompts/url-import") {
		t.Fatalf("resolved dir = %q, want prompts/url-import suffix", dir)
	}
}

func writePromptFixture(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write prompt fixture: %v", err)
	}
}
