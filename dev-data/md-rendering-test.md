---
title: "Markdown Rendering Test"
tags: ["test", "dev"]
servings: 4
prepMinutes: 10
cookMinutes: 30
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
---

A recipe to test all markdown rendering in the preview and notes sections.

## Ingredients

| Qty | Unit | Item |
| --- | --- | --- |
| 2 | cups | flour |
| 1 | tsp | salt |
| 3 | tbsp | olive oil |

## Instructions

1. **Bold step** -- this tests bold inside a numbered list.
2. *Italic step* -- this tests italic inside a numbered list.
3. A step with `inline code` for a temperature like `350F`.
4. A step with a [link](https://example.com) inline.
5. A step with nested items:
   - sub-item one
   - sub-item two
   - sub-item three
6. Another step after the nested list.
7. A step with **bold** and *italic* and `code` all together.

Here is an unordered list outside of numbered steps:

- First thing
- Second thing
- Third thing with **bold**

And a deeper nested list:

1. Outer numbered
   1. Inner numbered
   2. Inner numbered again
      - Deep bullet
      - Another deep bullet
2. Back to outer

---

A horizontal rule was above this line.

> This is a blockquote. It should be visually distinct.

Paragraph with ~~strikethrough~~ text.

## Notes

### Heading 3 in notes

Regular paragraph in notes. This should wrap nicely and have proper line height.

#### Heading 4 in notes

**Bold text**, *italic text*, ***bold italic text***, and `inline code`.

- Bullet one
- Bullet two
  - Nested bullet
  - Another nested bullet
    - Deeply nested
- Bullet three

1. Numbered one
2. Numbered two
   1. Nested numbered
   2. Another nested
3. Numbered three

> A blockquote in the notes section.
> It can span multiple lines.

A paragraph with a [link](https://example.com) and some `code`.

---

Text after a horizontal rule.

Mixed content paragraph with **bold**, *italic*, `code`, and ~~strikethrough~~ all in one line. Then a second sentence for wrap testing on narrower screens.

```
code block
  with indentation
    and more indentation
```

| Column A | Column B | Column C |
| -------- | -------- | -------- |
| cell 1   | cell 2   | cell 3   |
| cell 4   | cell 5   | cell 6   |
