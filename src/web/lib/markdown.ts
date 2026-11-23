/**
 * The Markdown subset from `src/ui/markdown.js`, ported verbatim.
 *
 * Contract that must not change:
 *
 * - The whole source is HTML-escaped **before** any block or inline rule runs
 *   (`markdown.js:199`), so a hostile payload can never become a live tag.
 * - Raw HTML is therefore never re-enabled; there is no second pass that would
 *   unescape it.
 * - Fenced code is escaped a second time on the way out. That double escape is
 *   the legacy behaviour (`markdown.js:118-120`) and is pinned by
 *   `test/web-markdown.test.ts`: an ampersand inside a fence reads `&amp;amp;`.
 *   It is ugly output, never a security hole, and is kept for byte parity.
 * - Links survive only for `http(s)://`, a single-leading-slash path and `#`
 *   targets without whitespace. A protocol-relative `//host` is rejected, so a
 *   transcript payload cannot point the anchor at another origin.
 *
 * Because the output is escaped first, every inner-HTML sink in `src/web` is fed
 * by this returned HTML — the drawer's text section and `StatsTable`'s two
 * step-detail blocks — so React's own escaping would only show the markup as
 * text.
 */

export const MARKDOWN_MAX_CHARS = 24_000;

export interface MarkdownResult {
  html: string;
  truncated: boolean;
}

/** `escapeHtml` (`format.js:3-10`). Kept local so the module stays DOM-free. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSafeHref(href: string): boolean {
  if (/^https?:\/\//i.test(href)) return true;
  if (href.startsWith("#")) return true;
  if (!href.startsWith("/")) return false;
  // A protocol-relative href (`//host`) leaves the origin, and a backslash is
  // normalised to `/` by the URL parser (`/\host`). Only a single leading
  // slash is a same-origin path; anything else stays plain text.
  return !href.startsWith("//") && !href.startsWith("/\\");
}

/**
 * One left-to-right scan for `[label](href)`. A regex could backtrack
 * quadratically on text containing many `[` characters (`markdown.js:7-11`).
 */
function renderLinks(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    if (open === -1) {
      out += text.slice(index);
      break;
    }
    const close = text.indexOf("]", open + 1);
    if (close === -1) {
      out += text.slice(index);
      break;
    }
    if (text[close + 1] !== "(") {
      out += text.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    const end = text.indexOf(")", close + 2);
    if (end === -1) {
      out += text.slice(index);
      break;
    }
    const label = text.slice(open + 1, close);
    const href = text.slice(close + 2, end);
    if (label.length > 0 && href.length > 0 && !/\s/.test(href) && isSafeHref(href)) {
      out += `${text.slice(index, open)}<a href="${href}" rel="noreferrer noopener">${label}</a>`;
      index = end + 1;
    } else {
      out += text.slice(index, close + 1);
      index = close + 1;
    }
  }
  return out;
}

function inline(text: string): string {
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return renderLinks(out);
}

function renderTable(
  lines: readonly string[],
  start: number,
): { html: string; next: number } | null {
  const header = lines[start];
  const separator = lines[start + 1];
  if (!header?.includes("|") || !separator || !/^\s*\|?[\s:|-]+\|?\s*$/.test(separator)) {
    return null;
  }
  const split = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const headers = split(header);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
    rows.push(split(lines[index]));
    index++;
  }
  const html = `<table class="md-table"><thead><tr>${headers
    .map((cell) => `<th>${inline(cell)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
  return { html, next: index };
}

function renderBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      out.push(
        `<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`,
      );
      list = null;
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      const language = line.replace(/^\s*```/, "").trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index++;
      }
      index++;
      out.push(
        `<pre class="md-code"><code${
          language ? ` data-language="${escapeHtml(language)}"` : ""
        }>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      index++;
      continue;
    }
    if (line.includes("|")) {
      const table = renderTable(lines, index);
      if (table) {
        flushParagraph();
        flushList();
        out.push(table.html);
        index = table.next;
        continue;
      }
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, Math.max(2, heading[1].length + 1));
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const tag = unordered ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((unordered ?? ordered)![1]);
      index++;
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flushParagraph();
      flushList();
      const quote: string[] = [];
      while (index < lines.length && /^\s*&gt;\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*&gt;\s?/, ""));
        index++;
      }
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push("<hr>");
      index++;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
    index++;
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}

/**
 * Renders the documented subset: headings, fenced code, lists, tables, quotes,
 * bold/italic, inline code and safe links.
 */
export function renderMarkdown(
  text: unknown,
  options: { maxChars?: number } = {},
): MarkdownResult {
  const maxChars = options.maxChars ?? MARKDOWN_MAX_CHARS;
  const source = String(text ?? "");
  if (source.length === 0) return { html: "", truncated: false };
  const clipped = source.length > maxChars ? source.slice(0, maxChars) : source;
  const escaped = escapeHtml(clipped);
  return {
    html: renderBlocks(escaped),
    truncated: source.length > maxChars,
  };
}
