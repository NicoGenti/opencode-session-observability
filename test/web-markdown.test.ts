import test from "node:test";
import assert from "node:assert/strict";
import { MARKDOWN_MAX_CHARS, escapeHtml, renderMarkdown } from "../src/web/lib/markdown.ts";

const html = (source: string, options?: { maxChars?: number }): string =>
  renderMarkdown(source, options).html;

/* --------------------------------------------------------------- the subset */

test("markdown: headings map onto h2..h4", () => {
  assert.equal(html("# One"), "<h2>One</h2>");
  assert.equal(html("## Two"), "<h3>Two</h3>");
  assert.equal(html("### Three"), "<h4>Three</h4>");
  assert.equal(html("#### Four"), "<h4>Four</h4>");
});

test("markdown: fenced code keeps its language and the legacy double escape", () => {
  assert.equal(
    html("```js\nconst a = 1 < 2;\n```"),
    '<pre class="md-code"><code data-language="js">const a = 1 &amp;lt; 2;</code></pre>',
  );
  // An ampersand inside a fence reads `&amp;amp;`: legacy byte parity, not a bug
  // that can turn into markup.
  assert.equal(
    html("```\na & b\n```"),
    '<pre class="md-code"><code>a &amp;amp; b</code></pre>',
  );
});

test("markdown: lists, quotes and rules", () => {
  assert.equal(html("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(html("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(html("> quoted text"), "<blockquote>quoted text</blockquote>");
  assert.equal(html("---"), "<hr>");
  // A paragraph break flushes the list.
  assert.equal(html("- one\n\ntwo"), "<ul><li>one</li></ul>\n<p>two</p>");
});

test("markdown: tables need a header pipe and a separator row", () => {
  assert.equal(
    html("| a | b |\n|---|---|\n| 1 | 2 |"),
    '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  );
  // Without a separator the pipe line stays a paragraph.
  assert.equal(html("| a | b |"), "<p>| a | b |</p>");
});

test("markdown: inline code, bold, italic and links", () => {
  assert.equal(html("a `code` b"), "<p>a <code>code</code> b</p>");
  assert.equal(html("**bold**"), "<p><strong>bold</strong></p>");
  assert.equal(html("*italic*"), "<p><em>italic</em></p>");
  assert.equal(
    html("[docs](https://example.com/a)"),
    '<p><a href="https://example.com/a" rel="noreferrer noopener">docs</a></p>',
  );
  assert.equal(
    html("[root](/path) and [anchor](#hash)"),
    '<p><a href="/path" rel="noreferrer noopener">root</a> and <a href="#hash" rel="noreferrer noopener">anchor</a></p>',
  );
});

test("markdown: unsafe or malformed links stay text", () => {
  assert.equal(html("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
  assert.equal(html("[x](data:text/html,hi)"), "<p>[x](data:text/html,hi)</p>");
  assert.equal(html("[x](https://a b)"), "<p>[x](https://a b)</p>");
  assert.equal(html("[x]"), "<p>[x]</p>");
  assert.equal(html("[x](https://a"), "<p>[x](https://a</p>");
  // Protocol-relative and backslash-normalized hosts leave the origin.
  assert.equal(html("[x](//evil.example)"), "<p>[x](//evil.example)</p>");
  assert.equal(html("[x](/\\evil.example)"), "<p>[x](/\\evil.example)</p>");
  assert.equal(html("[x](///evil.example)"), "<p>[x](///evil.example)</p>");
  // A single leading slash is still a same-origin path.
  assert.equal(
    html("[x](/docs/page)"),
    '<p><a href="/docs/page" rel="noreferrer noopener">x</a></p>',
  );
});

/* ------------------------------------------------------------------ escaping */

test("markdown: raw HTML is escaped first and never re-enabled", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const out = html(hostile);
  assert.equal(out, `<p>${escapeHtml(hostile)}</p>`);
  assert.equal(out.includes("<img"), false);
  assert.equal(out.includes("<script"), false);
});

test("markdown: hostile content inside every block stays inert", () => {
  const tag = "<svg onload=alert(1)>";
  assert.equal(html(`# ${tag}`), `<h2>${escapeHtml(tag)}</h2>`);
  assert.equal(html(`- ${tag}`), `<ul><li>${escapeHtml(tag)}</li></ul>`);
  assert.equal(html(`> ${tag}`), `<blockquote>${escapeHtml(tag)}</blockquote>`);
  assert.equal(
    html(`| ${tag} |\n|---|\n| ${tag} |`).includes("<svg"),
    false,
  );
  // A label is escaped before the link rule runs, so it cannot smuggle markup.
  assert.equal(
    html(`[${tag}](https://example.com)`),
    `<p><a href="https://example.com" rel="noreferrer noopener">${escapeHtml(tag)}</a></p>`,
  );
});

test("markdown: a hostile href can never break out of the attribute", () => {
  // The source is escaped first, so the quote becomes `&quot;` before the link
  // rule sees it and the attribute cannot be closed.
  const out = html('[x](https://e.com/"onmouseover="alert(1))');
  assert.equal(out.includes('onmouseover="'), false);
  assert.equal(out.includes("&quot;"), true);
  assert.equal(
    out,
    '<p><a href="https://e.com/&quot;onmouseover=&quot;alert(1" rel="noreferrer noopener">x</a>)</p>',
  );
});

test("markdown: bracket-heavy input is scanned linearly and stays text", () => {
  const source = "[".repeat(20_000);
  const out = html(source);
  assert.equal(out, `<p>${source}</p>`);
  assert.equal(out.includes("<a "), false);
});

test("markdown: truncation clips the source and says so", () => {
  const result = renderMarkdown("abcdef", { maxChars: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.html, "<p>abc</p>");
  assert.equal(MARKDOWN_MAX_CHARS, 24_000);
  const empty = renderMarkdown("");
  assert.deepEqual(empty, { html: "", truncated: false });
  assert.deepEqual(renderMarkdown(null), { html: "", truncated: false });
});
