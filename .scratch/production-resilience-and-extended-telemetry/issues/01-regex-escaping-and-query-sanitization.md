# 01 — Regex Metacharacter Escaping & Title Query Sanitization

**What to build:** Ensure all search terms, video titles, and release names containing regular expression metacharacters (`?`, `*`, `+`, `()`, `[]`, `$`, `^`, `\`) or stream query parameters (`?index=0`) are safely sanitized and escaped before constructing regular expressions, preventing unhandled `SyntaxError: Invalid regular expression: Nothing to repeat` crashes.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] All dynamic strings passed to `new RegExp()` in matching and extraction routines pass through an `escapeRegExp()` helper.
- [x] Query fragments such as `?index=\d+` are stripped from stream titles and IDs before tokenization.
- [x] Movie titles with punctuation (e.g. *"Who Framed Roger Rabbit?"*, *"What If...?"*) match and return subtitles cleanly without throwing regex syntax exceptions.
- [x] Automated unit test verifies regex escaping against a suite of titles with special characters.
