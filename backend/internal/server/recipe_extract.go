package server

// Recipe extraction functions ported from the test script (dev-data/llm-test/run-llm-extraction-test.ts).
// These convert JSON-LD recipe data into the simple text format used by the LLM pipeline,
// and parse the LLM output back into a structured recipe object.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// RecipeResponse is the structured recipe returned to the frontend.
type RecipeResponse struct {
	Title        string       `json:"title"`
	Description  string       `json:"description"`
	Servings     int          `json:"servings"`
	PrepMinutes  int          `json:"prepMinutes"`
	CookMinutes  int          `json:"cookMinutes"`
	Tags         []string     `json:"tags"`
	Ingredients  []Ingredient `json:"ingredients"`
	Instructions string       `json:"instructions"`
	ImageUrls    []string     `json:"imageUrls"`
}

// Ingredient is a single parsed ingredient.
type Ingredient struct {
	Quantity string `json:"quantity"`
	Unit     string `json:"unit"`
	Item     string `json:"item"`
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

// extractJsonLdRecipeData extracts the Recipe JSON object from HTML.
// Returns (recipe, true) if found, (nil, false) otherwise.
func extractJsonLdRecipeData(htmlContent string) (map[string]any, bool) {
	re := regexp.MustCompile(`(?i)<script[^>]*application/ld\+json[^>]*>([\s\S]*?)</script>`)
	for _, match := range re.FindAllStringSubmatch(htmlContent, -1) {
		if len(match) < 2 {
			continue
		}
		var data any
		if err := json.Unmarshal([]byte(match[1]), &data); err != nil {
			continue
		}
		if recipe := findRecipeInJsonLd(data); recipe != nil {
			return recipe, true
		}
	}
	return nil, false
}

// findRecipeInJsonLd recursively searches parsed JSON for @type "Recipe".
func findRecipeInJsonLd(data any) map[string]any {
	switch v := data.(type) {
	case map[string]any:
		// Direct @type match
		if t, ok := v["@type"]; ok {
			if s, ok := t.(string); ok && s == "Recipe" {
				return v
			}
			if arr, ok := t.([]any); ok {
				for _, item := range arr {
					if s, ok := item.(string); ok && s == "Recipe" {
						return v
					}
				}
			}
		}
		// Search @graph
		if graph, ok := v["@graph"]; ok {
			if found := findRecipeInJsonLd(graph); found != nil {
				return found
			}
		}
	case []any:
		for _, item := range v {
			if found := findRecipeInJsonLd(item); found != nil {
				return found
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Page image extraction
// ---------------------------------------------------------------------------

var (
	ogImageRe = regexp.MustCompile(`property="og:image"[^>]*content="([^"]+)"`)
	ogTitleRe = regexp.MustCompile(`property="og:title"[^>]*content="([^"]+)"`)
	imgTagRe  = regexp.MustCompile(`<img[^>]+src="([^"]+)"[^>]*>`)
	imgAltRe  = regexp.MustCompile(`alt="([^"]*)"`)
)

// extractPageImages extracts images from HTML as ![alt](url) markdown strings.
func extractPageImages(htmlContent string) []string {
	var images []string
	seen := make(map[string]bool)

	// OG image (priority)
	if m := ogImageRe.FindStringSubmatch(htmlContent); len(m) >= 2 {
		url := strings.ReplaceAll(m[1], "&amp;", "&")
		alt := ""
		if tm := ogTitleRe.FindStringSubmatch(htmlContent); len(tm) >= 2 {
			alt = strings.ReplaceAll(tm[1], "&amp;", "&")
			alt = strings.ReplaceAll(alt, "&#39;", "'")
		}
		images = append(images, fmt.Sprintf("![%s](%s)", alt, url))
		seen[url] = true
	}

	// Content images
	for _, m := range imgTagRe.FindAllStringSubmatch(htmlContent, -1) {
		if len(images) >= 15 {
			break
		}
		src := strings.ReplaceAll(m[1], "&amp;", "&")
		if seen[src] || strings.HasPrefix(src, "data:") {
			continue
		}
		lower := strings.ToLower(src)
		if strings.Contains(lower, "logo") || strings.Contains(lower, "icon") ||
			strings.Contains(lower, "avatar") || strings.Contains(lower, "badge") {
			continue
		}
		alt := ""
		if am := imgAltRe.FindStringSubmatch(m[0]); len(am) >= 2 {
			alt = decodeHtmlEntities(am[1])
		}
		images = append(images, fmt.Sprintf("![%s](%s)", alt, src))
		seen[src] = true
	}

	return images
}

// ---------------------------------------------------------------------------
// Build simple format from JSON-LD
// ---------------------------------------------------------------------------

// buildSimpleFormatFromJsonLd converts a JSON-LD Recipe object + page images
// into the pipe-delimited simple text format used by the LLM pipeline.
func buildSimpleFormatFromJsonLd(recipe map[string]any, pageImages []string) string {
	var lines []string

	lines = append(lines, fmt.Sprintf("TITLE: %s", anyStr(recipe["name"])))
	lines = append(lines, fmt.Sprintf("DESC: %s", stripHtmlTags(anyStr(recipe["description"]))))
	lines = append(lines, fmt.Sprintf("SERVINGS: %d", parseRecipeYield(recipe["recipeYield"])))
	lines = append(lines, fmt.Sprintf("PREP: %d", parseISO8601Duration(anyStr(recipe["prepTime"]))))
	lines = append(lines, fmt.Sprintf("COOK: %d", parseISO8601Duration(anyStr(recipe["cookTime"]))))
	lines = append(lines, fmt.Sprintf("TAGS: %s", strings.Join(parseTags(recipe["recipeCategory"], recipe["keywords"], recipe["recipeCuisine"]), ", ")))

	// Ingredients
	lines = append(lines, "", "INGREDIENTS:")
	if ings, ok := recipe["recipeIngredient"].([]any); ok {
		for _, ing := range ings {
			s, ok := ing.(string)
			if !ok {
				continue
			}
			qty, unit, item := parseIngredientRaw(s)
			lines = append(lines, fmt.Sprintf("%s | %s | %s", qty, unit, item))
		}
	}

	// Instructions
	lines = append(lines, "", "INSTRUCTIONS:")
	usedUrls := make(map[string]bool)

	// String instructions (single block of text/HTML)
	if instrStr, ok := recipe["recipeInstructions"].(string); ok {
		cleaned := strings.TrimSpace(stripHtmlTags(instrStr))
		if cleaned != "" {
			// Split into paragraphs → numbered steps
			paragraphs := strings.Split(cleaned, "\n\n")
			stepNum := 1
			for _, p := range paragraphs {
				p = strings.TrimSpace(p)
				if p == "" {
					continue
				}
				lines = append(lines, fmt.Sprintf("%d. %s", stepNum, p))
				stepNum++
			}
		}
	} else if instrs, ok := recipe["recipeInstructions"].([]any); ok {
		stepNum := 1
		for _, item := range instrs {
			switch v := item.(type) {
			case string:
				lines = append(lines, fmt.Sprintf("%d. %s", stepNum, stripHtmlTags(v)))
				stepNum++
			case map[string]any:
				// HowToStep
				text := ""
				if t, ok := v["text"].(string); ok {
					text = stripHtmlTags(t)
				} else if n, ok := v["name"].(string); ok {
					text = stripHtmlTags(n)
				}
				if text != "" {
					lines = append(lines, fmt.Sprintf("%d. %s", stepNum, text))
					stepNum++
				}

				// Step image
				if imgUrl := extractStepImageUrl(v["image"]); imgUrl != "" {
					alt := ""
					if n, ok := v["name"].(string); ok {
						alt = stripHtmlTags(n)
					}
					lines = append(lines, fmt.Sprintf("![%s](%s)", alt, imgUrl))
					usedUrls[imgUrl] = true
				}

				// HowToSection with itemListElement
				if subs, ok := v["itemListElement"].([]any); ok {
					for _, sub := range subs {
						subMap, ok := sub.(map[string]any)
						if !ok {
							continue
						}
						subText := ""
						if t, ok := subMap["text"].(string); ok {
							subText = stripHtmlTags(t)
						}
						if subText != "" {
							lines = append(lines, fmt.Sprintf("%d. %s", stepNum, subText))
							stepNum++
						}
						if subImg := extractStepImageUrl(subMap["image"]); subImg != "" {
							subAlt := ""
							if n, ok := subMap["name"].(string); ok {
								subAlt = stripHtmlTags(n)
							}
							lines = append(lines, fmt.Sprintf("![%s](%s)", subAlt, subImg))
							usedUrls[subImg] = true
						}
					}
				}
			}
		}
	}

	// Additional images (page images not used in steps)
	var unused []string
	urlRe := regexp.MustCompile(`\]\((.+)\)$`)
	for _, img := range pageImages {
		if m := urlRe.FindStringSubmatch(img); len(m) >= 2 {
			if !usedUrls[m[1]] {
				unused = append(unused, img)
			}
		} else {
			unused = append(unused, img)
		}
	}
	if len(unused) > 0 {
		lines = append(lines, "", "ADDITIONAL IMAGES:")
		lines = append(lines, unused...)
	}

	return strings.Join(lines, "\n")
}

// ---------------------------------------------------------------------------
// Parse simple format → RecipeResponse
// ---------------------------------------------------------------------------

// parseSimpleFormatToRecipe parses the LLM's simple text output into a RecipeResponse.
func parseSimpleFormatToRecipe(text string) (*RecipeResponse, error) {
	lines := strings.Split(text, "\n")

	// Parse header fields (KEY: value on a single line)
	header := func(key string) string {
		prefix := key + ":"
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(strings.ToUpper(trimmed), strings.ToUpper(prefix)) {
				return strings.TrimSpace(trimmed[len(prefix):])
			}
		}
		return ""
	}

	title := header("TITLE")
	if title == "" {
		return nil, fmt.Errorf("no TITLE found in LLM output")
	}

	// Find section boundaries by scanning lines
	ingStart, instrStart, addlStart := -1, -1, -1
	for i, line := range lines {
		upper := strings.ToUpper(strings.TrimSpace(line))
		if strings.HasPrefix(upper, "INGREDIENTS:") {
			ingStart = i + 1
		} else if strings.HasPrefix(upper, "INSTRUCTIONS:") {
			instrStart = i + 1
		} else if strings.HasPrefix(upper, "ADDITIONAL IMAGES:") {
			addlStart = i
		}
	}

	// Parse ingredients (lines between INGREDIENTS: and INSTRUCTIONS: or ADDITIONAL IMAGES:)
	var ingredients []Ingredient
	if ingStart >= 0 {
		ingEnd := len(lines)
		if instrStart > ingStart {
			ingEnd = instrStart - 1
		} else if addlStart > ingStart {
			ingEnd = addlStart
		}
		for i := ingStart; i < ingEnd; i++ {
			trimmed := strings.TrimSpace(lines[i])
			if trimmed == "" {
				continue
			}
			parts := strings.SplitN(trimmed, "|", 3)
			if len(parts) >= 3 {
				ingredients = append(ingredients, Ingredient{
					Quantity: strings.TrimSpace(parts[0]),
					Unit:     strings.TrimSpace(parts[1]),
					Item:     strings.TrimSpace(parts[2]),
				})
			}
		}
	}

	// Parse instructions (lines between INSTRUCTIONS: and ADDITIONAL IMAGES: or end)
	var instructions string
	if instrStart >= 0 {
		instrEnd := len(lines)
		if addlStart > instrStart {
			instrEnd = addlStart
		}
		instrLines := lines[instrStart:instrEnd]
		joined := strings.Join(instrLines, "\n")
		// Ensure blank line before each numbered step for proper markdown rendering
		numberedStepRe := regexp.MustCompile(`\n(\d+\.)`)
		joined = numberedStepRe.ReplaceAllString(joined, "\n\n$1")
		instructions = strings.TrimSpace(joined)
	}

	// Collect image URLs from ![alt](url) in instructions
	var imageUrls []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(instructions, "\n") {
		// Look for ![...](url) patterns
		idx := 0
		for idx < len(line) {
			start := strings.Index(line[idx:], "![")
			if start < 0 {
				break
			}
			start += idx
			closeBracket := strings.Index(line[start+2:], "](")
			if closeBracket < 0 {
				break
			}
			closeBracket += start + 2
			closeParen := strings.Index(line[closeBracket+2:], ")")
			if closeParen < 0 {
				break
			}
			closeParen += closeBracket + 2
			url := line[closeBracket+2 : closeParen]
			if url != "" && !seen[url] {
				imageUrls = append(imageUrls, url)
				seen[url] = true
			}
			idx = closeParen + 1
		}
	}

	// Parse tags
	var tags []string
	for _, t := range strings.Split(header("TAGS"), ",") {
		trimmed := strings.TrimSpace(strings.ToLower(t))
		if trimmed != "" {
			tags = append(tags, trimmed)
		}
	}

	servings, _ := strconv.Atoi(header("SERVINGS"))
	if servings == 0 {
		servings = 4
	}
	prepMinutes, _ := strconv.Atoi(header("PREP"))
	cookMinutes, _ := strconv.Atoi(header("COOK"))

	return &RecipeResponse{
		Title:        title,
		Description:  header("DESC"),
		Servings:     servings,
		PrepMinutes:  prepMinutes,
		CookMinutes:  cookMinutes,
		Tags:         tags,
		Ingredients:  ingredients,
		Instructions: instructions,
		ImageUrls:    imageUrls,
	}, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Unit aliases for ingredient parsing (matches test script UNIT_ALIASES)
var unitAliases = map[string]string{
	"tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp",
	"tbsp": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp", "tbs": "tbsp",
	"cup": "cup", "cups": "cup",
	"oz": "oz", "ounce": "oz", "ounces": "oz",
	"lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
	"g": "g", "gram": "g", "grams": "g",
	"ml": "ml", "milliliter": "ml", "milliliters": "ml",
	"piece": "piece", "pieces": "piece",
	"clove": "clove", "cloves": "clove",
	"can": "can", "cans": "can",
	"bunch": "bunch", "bunches": "bunch",
	"stalk": "stalk", "stalks": "stalk",
	"sprig": "sprig", "sprigs": "sprig",
	"slice": "slice", "slices": "slice",
	"head": "head", "heads": "head",
}

var qtyRe = regexp.MustCompile(`^([\d./\s]+)`)

// parseIngredientRaw splits "2 cups flour" into (qty, unit, item).
func parseIngredientRaw(raw string) (string, string, string) {
	s := strings.TrimSpace(raw)
	qty := ""
	if m := qtyRe.FindString(s); m != "" {
		qty = strings.TrimSpace(m)
		s = strings.TrimSpace(s[len(m):])
	}

	unit := ""
	words := strings.Fields(s)
	if len(words) >= 1 {
		candidate := strings.ToLower(strings.TrimSuffix(words[0], "."))
		if canonical, ok := unitAliases[candidate]; ok {
			unit = canonical
			s = strings.TrimSpace(strings.Join(words[1:], " "))
		}
	}

	// Strip leading "of "
	s = regexp.MustCompile(`(?i)^of\s+`).ReplaceAllString(s, "")
	item := strings.TrimSpace(s)
	if item == "" {
		item = strings.TrimSpace(raw)
	}
	return qty, unit, item
}

var iso8601Re = regexp.MustCompile(`(?i)PT(?:(\d+)H)?(?:(\d+)M)?`)

// parseISO8601Duration parses "PT1H30M" to 90 (minutes).
func parseISO8601Duration(s string) int {
	m := iso8601Re.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	hours, _ := strconv.Atoi(m[1])
	mins, _ := strconv.Atoi(m[2])
	return hours*60 + mins
}

// parseRecipeYield parses "4 servings" or "4" to 4.
func parseRecipeYield(val any) int {
	switch v := val.(type) {
	case float64:
		return int(v)
	case string:
		re := regexp.MustCompile(`(\d+)`)
		if m := re.FindStringSubmatch(v); len(m) >= 2 {
			n, _ := strconv.Atoi(m[1])
			return n
		}
	}
	return 4
}

// parseTags collects tags from recipeCategory, keywords, recipeCuisine.
func parseTags(sources ...any) []string {
	tags := make(map[string]bool)
	var result []string
	for _, val := range sources {
		switch v := val.(type) {
		case string:
			for _, t := range strings.Split(v, ",") {
				trimmed := strings.TrimSpace(strings.ToLower(t))
				if trimmed != "" && !tags[trimmed] {
					tags[trimmed] = true
					result = append(result, trimmed)
				}
			}
		case []any:
			for _, item := range v {
				s := strings.TrimSpace(strings.ToLower(fmt.Sprint(item)))
				if s != "" && !tags[s] {
					tags[s] = true
					result = append(result, s)
				}
			}
		}
	}
	return result
}

// extractStepImageUrl gets the first image URL from a Schema.org image field.
func extractStepImageUrl(val any) string {
	if val == nil {
		return ""
	}
	switch v := val.(type) {
	case string:
		return v
	case map[string]any:
		if url, ok := v["url"].(string); ok {
			return url
		}
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok {
				return s
			}
			if m, ok := item.(map[string]any); ok {
				if url, ok := m["url"].(string); ok {
					return url
				}
			}
		}
	}
	return ""
}

// stripHtmlTags removes HTML tags and decodes common entities.
func stripHtmlTags(html string) string {
	s := html
	// Convert <br> and block close tags to newlines
	s = regexp.MustCompile(`(?i)<br\s*/?>`).ReplaceAllString(s, "\n")
	s = regexp.MustCompile(`(?i)</(?:p|div|li|h[1-6])>`).ReplaceAllString(s, "\n")
	// Strip remaining tags
	s = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(s, "")
	// Decode entities
	s = decodeHtmlEntities(s)
	// Collapse whitespace
	s = regexp.MustCompile(`[ \t]+`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`\n{3,}`).ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// decodeHtmlEntities decodes common HTML entities.
func decodeHtmlEntities(s string) string {
	// Numeric entities
	s = regexp.MustCompile(`&#(\d+);`).ReplaceAllStringFunc(s, func(match string) string {
		numStr := match[2 : len(match)-1]
		n, err := strconv.Atoi(numStr)
		if err != nil {
			return match
		}
		return string(rune(n))
	})
	s = regexp.MustCompile(`&#x([0-9a-fA-F]+);`).ReplaceAllStringFunc(s, func(match string) string {
		hexStr := match[3 : len(match)-1]
		n, err := strconv.ParseInt(hexStr, 16, 32)
		if err != nil {
			return match
		}
		return string(rune(n))
	})
	// Named entities
	replacements := map[string]string{
		"&amp;": "&", "&lt;": "<", "&gt;": ">",
		"&quot;": `"`, "&#39;": "'", "&nbsp;": " ",
		"&eacute;": "é", "&egrave;": "è", "&uuml;": "ü",
		"&frac14;": "1/4", "&frac12;": "1/2", "&frac34;": "3/4",
		"&mdash;": "—", "&ndash;": "–",
		"&rsquo;": "'", "&lsquo;": "'",
		"&rdquo;": "\u201D", "&ldquo;": "\u201C",
		"&hellip;": "…", "&deg;": "°",
	}
	for entity, replacement := range replacements {
		s = strings.ReplaceAll(s, entity, replacement)
	}
	return s
}

// anyStr converts any value to string, handling nil.
func anyStr(val any) string {
	if val == nil {
		return ""
	}
	return fmt.Sprint(val)
}
