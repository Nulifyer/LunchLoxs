package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type llmPass string

const (
	llmPassRawExtract llmPass = "pass0"
	llmPassExtract    llmPass = "pass1"
	llmPassProcess    llmPass = "pass2"
	llmPassTag        llmPass = "pass3"
)

const (
	defaultPromptDirEnv = "LLM_PROMPT_DIR"
	defaultPromptRoot   = "url-import"
)

type llmTuning struct {
	Temperature float64
	TopP        float64
	MaxTokens   int
}

type llmConfig struct {
	APIKey         string
	Timeout        time.Duration
	ProbeTimeout   time.Duration
	ProbeInterval  time.Duration
	PromptDir      string
	CompletionsURL string
	Tuning         map[llmPass]llmTuning
}

type llmPrompts struct {
	RawExtract string
	Extract    string
	Process    string
	Tag        string
}

type llmClient struct {
	client  *http.Client
	config  llmConfig
	prompts llmPrompts
}

func loadLLMConfigFromEnv() llmConfig {
	timeout := durationEnvAny([]string{"LLM_TIMEOUT", "LLM_TIMEOUT_SECS"}, 20*time.Minute)

	global := llmTuning{
		Temperature: floatEnvAny([]string{"LLM_DEFAULT_TEMPERATURE"}, 0.7),
		TopP:        floatEnvAny([]string{"LLM_DEFAULT_TOP_P"}, 0.8),
		MaxTokens:   intEnvAny([]string{"LLM_DEFAULT_MAX_TOKENS"}, 8192),
	}

	cfg := llmConfig{
		APIKey:         strings.TrimSpace(os.Getenv("LLM_API_KEY")),
		Timeout:        timeout,
		ProbeTimeout:   durationEnvAny([]string{"LLM_PROBE_TIMEOUT"}, 90*time.Second),
		ProbeInterval:  durationEnvAny([]string{"LLM_PROBE_INTERVAL"}, 2*time.Second),
		PromptDir:      strings.TrimSpace(os.Getenv(defaultPromptDirEnv)),
		CompletionsURL: normalizeChatCompletionsURL(os.Getenv("LLM_ENDPOINT")),
		Tuning: map[llmPass]llmTuning{
			llmPassRawExtract: loadPassTuning("PASS0", global, llmTuning{Temperature: 0.6, TopP: 0.95, MaxTokens: 16384}),
			llmPassExtract:    loadPassTuning("PASS1", global, llmTuning{Temperature: 0.6, TopP: 0.95, MaxTokens: 16384}),
			llmPassProcess:    loadPassTuning("PASS2", global, llmTuning{Temperature: global.Temperature, TopP: global.TopP, MaxTokens: global.MaxTokens}),
			llmPassTag:        loadPassTuning("PASS3", global, llmTuning{Temperature: 0.6, TopP: 0.95, MaxTokens: 16384}),
		},
	}

	return cfg
}

func loadPassTuning(prefix string, global, fallback llmTuning) llmTuning {
	t := global
	if t.Temperature == 0 {
		t.Temperature = fallback.Temperature
	}
	if t.TopP == 0 {
		t.TopP = fallback.TopP
	}
	if t.MaxTokens == 0 {
		t.MaxTokens = fallback.MaxTokens
	}

	t.Temperature = floatEnvAny([]string{"LLM_" + prefix + "_TEMPERATURE"}, t.Temperature)
	t.TopP = floatEnvAny([]string{"LLM_" + prefix + "_TOP_P"}, t.TopP)
	t.MaxTokens = intEnvAny([]string{"LLM_" + prefix + "_MAX_TOKENS"}, t.MaxTokens)
	return t
}

func durationEnvAny(keys []string, fallback time.Duration) time.Duration {
	for _, key := range keys {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			if d, err := time.ParseDuration(v); err == nil && d > 0 {
				return d
			}
			if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
				return time.Duration(secs) * time.Second
			}
		}
	}
	return fallback
}

func floatEnvAny(keys []string, fallback float64) float64 {
	for _, key := range keys {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			if parsed, err := strconv.ParseFloat(v, 64); err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func intEnvAny(keys []string, fallback int) int {
	for _, key := range keys {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				return parsed
			}
		}
	}
	return fallback
}

func normalizeChatCompletionsURL(raw string) string {
	endpoint := strings.TrimSpace(raw)
	if endpoint == "" {
		return ""
	}
	endpoint = strings.TrimRight(endpoint, "/")
	if strings.HasSuffix(endpoint, "/v1/chat/completions") {
		return endpoint
	}
	return endpoint + "/v1/chat/completions"
}

func loadLLMPrompts(dirOverride string) (llmPrompts, error) {
	dir, err := resolvePromptDir(dirOverride)
	if err != nil {
		return llmPrompts{}, err
	}

	rawExtract, err := readPromptFile(dir, "pass0-raw-extract.txt")
	if err != nil {
		return llmPrompts{}, err
	}
	extract, err := readPromptFile(dir, "pass1-extract.txt")
	if err != nil {
		return llmPrompts{}, err
	}
	process, err := readPromptFile(dir, "pass2-process.txt")
	if err != nil {
		return llmPrompts{}, err
	}
	tag, err := readPromptFile(dir, "pass3-tag.txt")
	if err != nil {
		return llmPrompts{}, err
	}

	return llmPrompts{
		RawExtract: rawExtract,
		Extract:    extract,
		Process:    process,
		Tag:        tag,
	}, nil
}

func resolvePromptDir(dirOverride string) (string, error) {
	candidates := []string{}
	if dirOverride != "" {
		candidates = append(candidates, dirOverride)
	}
	candidates = append(candidates,
		filepath.Join("prompts", defaultPromptRoot),
		filepath.Join("backend", "prompts", defaultPromptRoot),
		filepath.Join("..", "..", "..", "prompts", defaultPromptRoot),
		filepath.Join("/app", "prompts", defaultPromptRoot),
	)

	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("prompt directory not found; set %s to a valid path", defaultPromptDirEnv)
}

func readPromptFile(dir, name string) (string, error) {
	path := filepath.Join(dir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read prompt %s: %w", path, err)
	}
	return strings.TrimSpace(string(data)), nil
}

func newLLMClient(config llmConfig) (*llmClient, error) {
	if config.CompletionsURL == "" {
		return nil, nil
	}
	prompts, err := loadLLMPrompts(config.PromptDir)
	if err != nil {
		return nil, err
	}
	return &llmClient{
		client:  &http.Client{Timeout: config.Timeout},
		config:  config,
		prompts: prompts,
	}, nil
}

func (c *llmClient) call(ctx context.Context, pass llmPass, system, user string) (string, error) {
	tuning, ok := c.config.Tuning[pass]
	if !ok {
		return "", fmt.Errorf("missing LLM tuning for %s", pass)
	}

	llmReq := map[string]any{
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"temperature": tuning.Temperature,
		"top_p":       tuning.TopP,
		"max_tokens":  tuning.MaxTokens,
	}
	llmBody, err := json.Marshal(llmReq)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.config.CompletionsURL, bytes.NewReader(llmBody))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.config.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.config.APIKey)
	}

	resp, err := c.doWithReadinessRetry(ctx, httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var llmResp struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, proxyMaxBody)).Decode(&llmResp); err != nil {
		return "", fmt.Errorf("failed to parse LLM response: %w", err)
	}
	if len(llmResp.Choices) == 0 {
		return "", fmt.Errorf("LLM returned no choices")
	}

	content := strings.TrimSpace(extractChoiceContent(llmResp.Choices[0].Message.Content))
	if idx := strings.Index(content, "<think>"); idx == 0 {
		if end := strings.Index(content, "</think>"); end > 0 {
			content = strings.TrimSpace(content[end+len("</think>"):])
		}
	}
	if strings.HasPrefix(content, "```") {
		lines := strings.Split(content, "\n")
		if len(lines) >= 3 {
			content = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	content = stripReasoningSpillover(content)
	return content, nil
}

func (c *llmClient) doWithReadinessRetry(ctx context.Context, req *http.Request) (*http.Response, error) {
	probeTimeout := c.config.ProbeTimeout
	if probeTimeout <= 0 {
		probeTimeout = 90 * time.Second
	}
	probeInterval := c.config.ProbeInterval
	if probeInterval <= 0 {
		probeInterval = 2 * time.Second
	}

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	var lastErr error
	for {
		attemptReq := req.Clone(probeCtx)
		if req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			attemptReq.Body = body
		}

		resp, err := c.client.Do(attemptReq)
		if err == nil {
			if resp.StatusCode == http.StatusOK {
				return resp, nil
			}

			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			lastErr = formatLLMStatusError(resp.StatusCode, strings.TrimSpace(string(body)))
			if resp.StatusCode != http.StatusServiceUnavailable {
				return nil, lastErr
			}
		} else {
			lastErr = fmt.Errorf("LLM request failed: %w", err)
		}

		if probeCtx.Err() != nil {
			if lastErr != nil {
				return nil, fmt.Errorf("LLM not ready after %s: %w", probeTimeout, lastErr)
			}
			return nil, fmt.Errorf("LLM not ready after %s", probeTimeout)
		}

		select {
		case <-probeCtx.Done():
			if lastErr != nil {
				return nil, fmt.Errorf("LLM not ready after %s: %w", probeTimeout, lastErr)
			}
			return nil, fmt.Errorf("LLM not ready after %s", probeTimeout)
		case <-time.After(probeInterval):
		}
	}
}

func formatLLMStatusError(statusCode int, body string) error {
	if body == "" {
		return fmt.Errorf("LLM returned %d", statusCode)
	}
	return fmt.Errorf("LLM returned %d: %s", statusCode, body)
}

func extractChoiceContent(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, item := range v {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}
