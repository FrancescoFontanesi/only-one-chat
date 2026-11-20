# 0024. Markdown and LaTeX in agent messages

Status: Accepted (iteration 3). Clarifies threat T6 in [security.md](../security.md) and file references in ADR 0018.

## Context

- **Agent messages were rendered as plain text.** Headings, bold, lists, tables, and code blocks kept their visible markers, and formulas appeared as LaTeX source.
- **Model-generated Markdown is untrusted** (T6). The webview's strict CSP disallows inline scripts, inline styles, and network access.
- **Agents refer to files through links and inline code**, for example `[README.md](file:///C:/…/README.md)`, `[app.py](app.py)`, `` `src/masks.py` ``, and `` `a.py:12` ``. Previously, only `@path` was clickable.

## Decision

1. **Render Markdown with a dependency-free renderer** (`webview/markdownModel.ts` and `webview/markdown.tsx`).
   - The renderer produces Preact elements exclusively. It displays any HTML in model output as text, so no sanitization is needed.
   - The subset used by the CLIs includes headings, paragraphs, nested and mixed lists, block quotes, code blocks, tables, horizontal rules, inline code, bold, italics, and links.
   - It handles streamed text, including an unfinished code block.
   - Body text uses Regular (400) and bold text uses Bold (700). Rajdhani weights 500 and 700 are hard to distinguish.
2. **File references.**
   - The host recognizes `@path`, Markdown link targets, and inline code shaped like a path, including `#L10-20` and `:12` line references.
   - References are clickable only when the file exists inside the open folder, even with an absolute path.
   - `openFile` accepts absolute paths inside the folder only, and the host performs the check.
   - Other links display their text with the address as the title. The webview does not open the address.
   - As in Copilot Chat and Claude Code, a file appears as a chip with monospace text, a border, muted line numbers after the name, a ↗, and inverted colors on hover. Its title shows the full path. Inline code has a solid background and no border, so it is distinguishable from file references.
   - References are recalculated when a chat reopens.
3. **Render LaTeX with KaTeX 0.19.1** (MIT), targeting MathML.
   - Recognize `$…$`, `\(…\)`, `$$…$$`, and `\[…\]`. Following Pandoc's rule, `$` opens only when followed by a non-space character. It closes only when preceded by a non-space character and followed by no digit. For example, "$5 and $10" stays plain text and `\$` renders as a dollar sign.
   - The browser renders MathML without KaTeX stylesheets, fonts, or inline styles.
   - KaTeX produces the markup. Settings include `trust: false` to disable `\href` and HTML commands, bounded `maxSize` and `maxExpand`, and `throwOnError: false` so an invalid formula shows its source.
   - The webview inserts markup through `dangerouslySetInnerHTML` for this KaTeX output only.
   - Rendered formulas are cached because streaming rerenders the same text repeatedly.

## Consequences

- The webview bundle grows by about 250 KB.
- Images, footnotes, and task lists are unsupported. Model-generated HTML remains plain text.
- MathML relies on VS Code's browser engine (Chromium) and looks less polished than KaTeX CSS. KaTeX CSS and fonts could be served from `media` if needed.
