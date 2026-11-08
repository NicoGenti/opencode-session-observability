import { escapeHtml } from "./format.js";

function isSafeHref(href) {
  return /^https?:\/\//i.test(href) || href.startsWith("/") || href.startsWith("#");
}

/**
 * Scans for [label](href) links in one pass. The previous regex could
 * backtrack quadratically on text containing many "[" characters.
 */
function renderLinks(text) {
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

function inline(text) {
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return renderLinks(out);
}

function renderTable(lines, start) {
  const header = lines[start];
  const separator = lines[start + 1];
  if (!header?.includes("|") || !separator || !/^\s*\|?[\s:|-]+\|?\s*$/.test(separator)) {
    return null;
  }
  const split = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const headers = split(header);
  const rows = [];
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

function renderBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let paragraph = [];
  let list = null;
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      const language = line.replace(/^\s*```/, "").trim();
      const code = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index++;
      }
      index++;
      out.push(
        `<pre class="md-code"><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(
          code.join("\n"),
        )}</code></pre>`,
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
      list.items.push((unordered ?? ordered)[1]);
      index++;
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flushParagraph();
      flushList();
      const quote = [];
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
 * Renders the small Markdown subset used in transcripts: headings, fenced
 * code, lists, tables, quotes, bold/italic, inline code and safe links.
 * Raw HTML is escaped first and never re-enabled.
 */
export function renderMarkdown(text, options = {}) {
  const maxChars = options.maxChars ?? 24_000;
  const source = String(text ?? "");
  if (source.length === 0) return { html: "", truncated: false };
  const clipped = source.length > maxChars ? source.slice(0, maxChars) : source;
  const escaped = escapeHtml(clipped);
  return {
    html: renderBlocks(escaped),
    truncated: source.length > maxChars,
  };
}
