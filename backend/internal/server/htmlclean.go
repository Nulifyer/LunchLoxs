package server

import (
	"fmt"
	"strings"

	"golang.org/x/net/html"
)

// cleanHtmlForLlm extracts structured readable text from HTML for LLM processing.
// It isolates the main content area, removes junk, and converts the DOM tree to
// text with markdown headings, bullet lists, and inline <img> tags preserved.
func cleanHtmlForLlm(rawHTML string) string {
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return rawHTML // fallback to raw
	}

	title := extractTitle(doc)

	// Find main content container: article > main > .entry-content > .entry > #content > body
	contentNode := findContainer(doc)
	if contentNode == nil {
		contentNode = findFirstElement(doc, "body")
	}
	if contentNode == nil {
		return rawHTML
	}

	// Remove junk elements
	removeElements(contentNode, []string{
		"script", "style", "nav", "footer", "header", "aside",
		"iframe", "svg", "noscript", "form",
	})
	removeByClass(contentNode, []string{
		"comment", "share", "social", "related", "sidebar",
		"widget", "advertisement", "popular-post", "post-navigation",
	})
	removeByID(contentNode, []string{"comments", "sidebar"})

	// Walk the tree and build structured text
	var b strings.Builder
	if title != "" {
		b.WriteString("# ")
		b.WriteString(title)
		b.WriteString("\n\n")
	}

	seenImgs := make(map[string]bool)
	stopped := false
	walkNode(contentNode, &b, seenImgs, &stopped)

	text := b.String()

	// Collapse whitespace
	text = collapseWhitespace(text)

	// Truncate
	if len(text) > 15000 {
		text = text[:15000] + "\n[... truncated]"
	}

	return text
}

// extractTitle finds the <title> element text.
func extractTitle(doc *html.Node) string {
	var title string
	var f func(*html.Node)
	f = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "title" {
			if n.FirstChild != nil {
				title = strings.TrimSpace(n.FirstChild.Data)
			}
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			f(c)
		}
	}
	f(doc)
	return title
}

// findContainer looks for the best content container element.
func findContainer(doc *html.Node) *html.Node {
	// Priority order — broad structural elements
	selectors := []struct {
		tag   string
		class string
		id    string
	}{
		{tag: "article"},
		{tag: "main"},
		{class: "entry-content"},
		{class: "post-content"},
		{class: "article-body"},
		{class: "post-body"},
		{class: "entry"},
		{class: "hentry"},
		{id: "content"},
	}

	for _, sel := range selectors {
		var found *html.Node
		var f func(*html.Node)
		f = func(n *html.Node) {
			if found != nil {
				return
			}
			if n.Type == html.ElementNode {
				if sel.tag != "" && n.Data == sel.tag {
					found = n
					return
				}
				if sel.class != "" && hasClass(n, sel.class) {
					found = n
					return
				}
				if sel.id != "" && getAttr(n, "id") == sel.id {
					found = n
					return
				}
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				f(c)
			}
		}
		f(doc)
		if found != nil && innerHTMLLength(found) > 200 {
			return found
		}
	}
	return nil
}

// isJunkHeading returns true if the heading text indicates non-recipe content.
func isJunkHeading(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	prefixes := []string{
		"related", "more recipes", "you may also like", "you also like",
		"recommended", "popular", "recent posts",
		"leave a comment", "leave a reply", "leave a review",
		"write a review", "comments",
		"about the author", "meet ", "author",
		"categories", "archives", "tags:",
		"share this", "follow", "subscribe",
		"newsletter", "blogroll",
	}
	for _, p := range prefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	// Match "4 comments", "12 responses", etc.
	if len(lower) > 0 && lower[0] >= '0' && lower[0] <= '9' {
		if strings.Contains(lower, "comment") || strings.Contains(lower, "response") || strings.Contains(lower, "review") {
			return true
		}
	}
	return false
}

// walkNode recursively converts DOM nodes to structured text.
// stopped is set to true when a junk heading is encountered; caller should check it.
func walkNode(n *html.Node, b *strings.Builder, seenImgs map[string]bool, stopped *bool) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if *stopped {
			return
		}
		switch c.Type {
		case html.TextNode:
			t := strings.ReplaceAll(c.Data, "\t", " ")
			trimmed := strings.TrimSpace(t)
			if trimmed != "" {
				b.WriteString(t)
			}

		case html.ElementNode:
			tag := c.Data

			// Headings → markdown (stop if junk heading)
			if len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6' {
				level := int(tag[1] - '0')
				if level > 3 {
					level = 3
				}
				text := strings.TrimSpace(textContent(c))
				if text != "" && isJunkHeading(text) {
					*stopped = true
					return
				}
				if text != "" {
					b.WriteString("\n")
					b.WriteString(strings.Repeat("#", level))
					b.WriteString(" ")
					b.WriteString(text)
					b.WriteString("\n")
				}
				continue
			}

			// Images → keep full <img> tag
			if tag == "img" {
				src := strings.ReplaceAll(getAttr(c, "src"), "&amp;", "&")
				if src == "" || strings.HasPrefix(src, "data:") || seenImgs[src] {
					continue
				}
				if isJunkImage(src) {
					continue
				}
				seenImgs[src] = true
				b.WriteString("\n")
				b.WriteString(renderImgTag(c))
				b.WriteString("\n")
				continue
			}

			// List items → bullet
			if tag == "li" {
				text := strings.TrimSpace(textContent(c))
				if text != "" {
					b.WriteString("- ")
					b.WriteString(text)
					b.WriteString("\n")
				}
				continue
			}

			// Block elements → recurse with spacing
			if isBlockElement(tag) {
				walkNode(c, b, seenImgs, stopped)
				b.WriteString("\n")
				continue
			}

			// Inline/other → recurse
			walkNode(c, b, seenImgs, stopped)
		}
	}
}

// textContent returns the combined text content of a node and its children.
func textContent(n *html.Node) string {
	var b strings.Builder
	var f func(*html.Node)
	f = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			f(c)
		}
	}
	f(n)
	return b.String()
}

// renderImgTag rebuilds a clean <img> tag string with key attributes.
func renderImgTag(n *html.Node) string {
	src := getAttr(n, "src")
	alt := getAttr(n, "alt")
	title := getAttr(n, "title")
	width := getAttr(n, "width")
	height := getAttr(n, "height")

	var b strings.Builder
	b.WriteString(`<img src="`)
	b.WriteString(strings.ReplaceAll(src, "&amp;", "&"))
	b.WriteString(`"`)
	if alt != "" {
		b.WriteString(fmt.Sprintf(` alt="%s"`, alt))
	}
	if title != "" {
		b.WriteString(fmt.Sprintf(` title="%s"`, title))
	}
	if width != "" {
		b.WriteString(fmt.Sprintf(` width="%s"`, width))
	}
	if height != "" {
		b.WriteString(fmt.Sprintf(` height="%s"`, height))
	}
	b.WriteString(">")
	return b.String()
}

func isJunkImage(src string) bool {
	lower := strings.ToLower(src)
	junk := []string{"logo", "icon", "avatar", "badge", "award", "pixel",
		"gravatar", "wp-smiley", "emoji", "banner", "tracking"}
	for _, j := range junk {
		if strings.Contains(lower, j) {
			return true
		}
	}
	// Skip .gif tracking pixels
	if strings.HasSuffix(strings.SplitN(lower, "?", 2)[0], ".gif") {
		return true
	}
	return false
}

func isBlockElement(tag string) bool {
	switch tag {
	case "p", "div", "section", "blockquote", "ul", "ol", "figure", "figcaption", "article", "main":
		return true
	}
	return false
}

// removeElements removes all elements with the given tag names.
func removeElements(root *html.Node, tags []string) {
	tagSet := make(map[string]bool, len(tags))
	for _, t := range tags {
		tagSet[t] = true
	}
	var toRemove []*html.Node
	var f func(*html.Node)
	f = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && tagSet[c.Data] {
				toRemove = append(toRemove, c)
			} else {
				f(c)
			}
		}
	}
	f(root)
	for _, n := range toRemove {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	}
}

// removeByClass removes elements whose class attribute contains any of the given substrings.
func removeByClass(root *html.Node, classes []string) {
	var toRemove []*html.Node
	var f func(*html.Node)
	f = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode {
				cls := getAttr(c, "class")
				remove := false
				for _, sub := range classes {
					if strings.Contains(cls, sub) {
						remove = true
						break
					}
				}
				if remove {
					toRemove = append(toRemove, c)
				} else {
					f(c)
				}
			}
		}
	}
	f(root)
	for _, n := range toRemove {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	}
}

// removeByID removes elements whose id attribute matches any of the given values.
func removeByID(root *html.Node, ids []string) {
	idSet := make(map[string]bool, len(ids))
	for _, id := range ids {
		idSet[id] = true
	}
	var toRemove []*html.Node
	var f func(*html.Node)
	f = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && idSet[getAttr(c, "id")] {
				toRemove = append(toRemove, c)
			} else {
				f(c)
			}
		}
	}
	f(root)
	for _, n := range toRemove {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	}
}

func hasClass(n *html.Node, class string) bool {
	cls := getAttr(n, "class")
	if cls == "" {
		return false
	}
	for _, c := range strings.Fields(cls) {
		if c == class {
			return true
		}
	}
	return false
}

func getAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func findFirstElement(root *html.Node, tag string) *html.Node {
	var found *html.Node
	var f func(*html.Node)
	f = func(n *html.Node) {
		if found != nil {
			return
		}
		if n.Type == html.ElementNode && n.Data == tag {
			found = n
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			f(c)
		}
	}
	f(root)
	return found
}

func innerHTMLLength(n *html.Node) int {
	var length int
	var f func(*html.Node)
	f = func(n *html.Node) {
		if n.Type == html.TextNode {
			length += len(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			f(c)
		}
	}
	f(n)
	return length
}

func collapseWhitespace(s string) string {
	// Collapse horizontal whitespace
	var prev rune
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if prev != ' ' && prev != '\t' && prev != '\n' {
				b.WriteRune(' ')
			}
			prev = ' '
			continue
		}
		if r == '\n' {
			// Strip trailing spaces before newline
			str := b.String()
			if len(str) > 0 && str[len(str)-1] == ' ' {
				b.Reset()
				b.WriteString(str[:len(str)-1])
			}
			b.WriteRune('\n')
			prev = '\n'
			continue
		}
		// Skip leading spaces after newline
		if prev == '\n' && (r == ' ' || r == '\t') {
			continue
		}
		b.WriteRune(r)
		prev = r
	}

	// Collapse 3+ newlines to 2
	result := b.String()
	for strings.Contains(result, "\n\n\n") {
		result = strings.ReplaceAll(result, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(result)
}
