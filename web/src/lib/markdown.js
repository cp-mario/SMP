const ATTR_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c]);
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]);
}

function safeUrl(url, { image = false } = {}) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:/i.test(value)) return value;
  if (/^[#/]/.test(value)) return value;
  if (image && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value)) return value;
  return "";
}

function normalizeCode(code) {
  let value = String(code || "").replace(/\n$/, "");
  if (/^ .* $/.test(value) && !/^ +$/.test(value)) value = value.slice(1, -1);
  return value.replace(/\n/g, " ");
}

function inlineFormatWithStore(text, store) {
  const hold = (html) => {
    const token = `\uE000SMP${store.length}\uE000`;
    store.push(html);
    return token;
  };
  let s = String(text ?? "");

  s = s.replace(/(`+)([\s\S]*?)\1/g, (_, ticks, code) => hold(`<code>${escapeText(normalizeCode(code))}</code>`));
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, (tag) => hold(tag));

  s = s.replace(/!\[([^\]]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)/g, (_, alt, url, doubleTitle, singleTitle, parenTitle) => {
    const title = doubleTitle ?? singleTitle ?? parenTitle ?? "";
    const src = safeUrl(url, { image: true });
    if (!src) return alt || "";
    return hold(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">`);
  });
  s = s.replace(/\[([^\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)/g, (_, label, url, doubleTitle, singleTitle, parenTitle) => {
    const title = doubleTitle ?? singleTitle ?? parenTitle ?? "";
    const href = safeUrl(url);
    if (!href) return label;
    return hold(`<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${inlineFormatWithStore(label, store)}</a>`);
  });

  s = s.replace(/<((?:https?|mailto):[^\s>]+)>/g, (_, url) => {
    const href = safeUrl(url);
    if (!href) return url;
    return hold(`<a href="${escapeHtml(href)}">${escapeText(href)}</a>`);
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, prefix, url) => {
    const trailing = (url.match(/[.,;:!?]+$/) || [""])[0];
    const clean = url.slice(0, url.length - trailing.length);
    const href = safeUrl(clean);
    if (!href) return prefix + url;
    return prefix + hold(`<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`) + trailing;
  });

  s = escapeText(s);

  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/___([^_\n]+)___/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_\n]+)_/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    if (s === before) break;
  }

  s = s.replace(/ {2,}\n/g, "<br>");
  s = s.replace(/\\\n/g, "<br>");
  s = s.replace(/\n/g, " ");
  s = s.replace(/\uE000SMP(\d+)\uE000/g, (_, i) => store[Number(i)] ?? "");
  return s;
}

function inlineFormat(text) {
  return inlineFormatWithStore(text, []);
}

function isBlockStart(line) {
  return /^\s*(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|```|~~~)/.test(line)
    || /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)
    || /^\s*<\/?[a-zA-Z][\w-]*(\s|\/?>|$)/.test(line)
    || /^\s*<!--/.test(line)
    || (line.includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(line));
}

function splitRow(line) {
  let s = String(line).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (char === "\\" && s[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(cell) {
  const value = String(cell || "").replace(/\s+/g, "");
  if (!/^:?-+:?$/.test(value)) return "";
  const left = value.startsWith(":");
  const right = value.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function isTableDelimiter(line) {
  if (!String(line || "").includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

function renderTable(lines, startIndex) {
  const header = splitRow(lines[startIndex]);
  const delimiter = splitRow(lines[startIndex + 1] || "");
  const aligns = delimiter.map(parseAlign);
  const width = header.length;
  let i = startIndex + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const cell = (tag, value, index) => {
    const align = aligns[index];
    const style = align ? ` style="text-align:${align}"` : "";
    return `<${tag}${style}>${inlineFormat(value ?? "")}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((c, index) => cell("th", c, index)).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${Array.from({ length: width }, (_, index) => cell("td", row[index] ?? "", index)).join("")}</tr>`).join("")}</tbody>`
    : "";
  return { html: `<table>${head}${body}</table>`, next: i };
}

function renderListItem(itemLines) {
  let content = itemLines.join("\n");
  let checkbox = "";
  const task = content.match(/^\[([ xX])\]\s+/);
  if (task) {
    checkbox = `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> `;
    content = content.slice(task[0].length);
  }
  const html = renderMarkdown(content);
  const firstParagraph = html.match(/^<p>([\s\S]*?)<\/p>([\s\S]*)$/);
  if (firstParagraph) return `<li>${checkbox}${firstParagraph[1]}${firstParagraph[2].replace(/^\s+/, "")}</li>`;
  return `<li>${checkbox}${html}</li>`;
}

function renderList(lines, startIndex) {
  const first = lines[startIndex].match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = startIndex;
  while (i < lines.length) {
    const match = lines[i].match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) break;
    const contentIndent = match[1].length + match[2].length + match[3].length;
    const itemLines = [match[4]];
    i++;
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim()) {
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next >= lines.length) {
          i = next;
          break;
        }
        const nextLine = lines[next];
        const nextIndent = (nextLine.match(/^\s*/) || [""])[0].length;
        const nextItem = nextLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (nextIndent > baseIndent || (nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered)) {
          itemLines.push("");
          i = next;
          continue;
        }
        break;
      }
      const indent = (raw.match(/^\s*/) || [""])[0].length;
      const item = raw.match(/^(\s*)([-*+]|\d+[.)])\s+/);
      if (item && indent <= baseIndent) break;
      if (indent <= baseIndent && isBlockStart(raw)) break;
      if (indent > baseIndent) {
        itemLines.push(raw.slice(Math.min(indent, contentIndent)));
        i++;
      } else {
        itemLines.push(raw.trim());
        i++;
      }
    }
    items.push(renderListItem(itemLines));
  }
  const tag = ordered ? "ol" : "ul";
  const startNumber = Number((first[2].match(/\d+/) || [1])[0]);
  const start = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
  return { html: `<${tag}${start}>${items.join("")}</${tag}>`, next: i };
}

function renderDetails(lines, startIndex) {
  const block = [];
  let depth = 0;
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    block.push(line);
    depth += (line.match(/<details\b/gi) || []).length;
    depth -= (line.match(/<\/details>/gi) || []).length;
    i++;
    if (depth <= 0) break;
  }
  let inner = block.join("\n").replace(/^[\s\S]*?<details\b[^>]*>/i, "").replace(/<\/details>[\s\S]*$/i, "");
  let summary = "";
  const summaryMatch = inner.match(/^\s*(<summary\b[^>]*>[\s\S]*?<\/summary>)\s*/i);
  if (summaryMatch) {
    summary = summaryMatch[1];
    inner = inner.slice(summaryMatch[0].length);
  }
  return { html: `<details>${summary}${renderMarkdown(inner)}</details>`, next: i };
}

export function renderMarkdown(markdown) {
  const source = String(markdown || "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
    if (fence) {
      const marker = fence[1];
      const char = marker[0];
      const length = marker.length;
      const lang = (fence[2].trim().split(/\s+/)[0] || "").replace(/[^\w+#.-]/g, "");
      const code = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (close && close[1][0] === char && close[1].length >= length) {
          i++;
          break;
        }
        code.push(lines[i]);
        i++;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeText(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/\s+#+\s*$/, "").trim();
      out.push(`<h${level}>${inlineFormat(text)}</h${level}>`);
      i++;
      continue;
    }

    if (i + 1 < lines.length && line.trim() && !isBlockStart(line) && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1])) {
      const level = lines[i + 1].trim().startsWith("=") ? 1 : 2;
      out.push(`<h${level}>${inlineFormat(line.trim())}</h${level}>`);
      i += 2;
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.includes("|") && isTableDelimiter(lines[i + 1] || "")) {
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (/^\s*<details\b/i.test(line)) {
      const details = renderDetails(lines, i);
      out.push(details.html);
      i = details.next;
      continue;
    }

    if (/^\s*<\/?[a-zA-Z][\w-]*(\s|\/?>|$)/.test(line) || /^\s*<!--/.test(line)) {
      const html = [];
      while (i < lines.length && lines[i].trim() && (/^\s*</.test(lines[i]))) {
        html.push(lines[i]);
        i++;
      }
      out.push(html.join("\n"));
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    if (!paragraph.length) {
      out.push(`<p>${inlineFormat(lines[i])}</p>`);
      i++;
      continue;
    }
    out.push(`<p>${inlineFormat(paragraph.join("\n"))}</p>`);
  }
  return sanitizeHtml(out.join("\n"));
}

const ALLOWED_TAGS = new Set([
  "a", "img", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code", "strong", "em", "b", "i",
  "del", "s", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "center", "details", "summary", "span", "div", "section", "figure", "figcaption",
  "sub", "sup", "mark", "kbd", "small", "u", "input", "picture", "source", "map", "area",
  "iframe",
]);

const DROP_TAGS = new Set([
  "script", "style", "object", "embed", "form", "button",
  "textarea", "select", "option", "optgroup", "meta", "link", "base", "svg",
  "math", "template", "noscript", "video", "audio", "canvas", "frame",
  "frameset", "applet", "param",
]);

const GLOBAL_ATTRS = new Set([
  "title", "alt", "href", "src", "width", "height", "loading", "colspan", "rowspan", "start", "open",
  "type", "checked", "disabled", "name", "coords", "shape", "usemap", "srcset", "sizes", "media",
  "allow", "allowfullscreen", "referrerpolicy", "crossorigin", "decoding", "align",
]);

const STYLE_PROPS = new Set(["text-align", "float", "image-rendering"]);

function sanitizeStyle(value) {
  return String(value || "")
    .split(";")
    .map((declaration) => {
      const index = declaration.indexOf(":");
      if (index < 0) return "";
      const prop = declaration.slice(0, index).trim().toLowerCase();
      let val = declaration.slice(index + 1).trim().toLowerCase();
      if (!STYLE_PROPS.has(prop)) return "";
      if (/[<>(){};"']|url\(|expression|javascript:/i.test(val)) return "";
      if (prop === "text-align" && !/^(left|right|center|justify|start|end)$/.test(val)) return "";
      if (prop === "float" && !/^(left|right|none)$/.test(val)) return "";
      if (prop === "image-rendering" && !/^(auto|pixelated)$/.test(val)) return "";
      return `${prop}: ${val}`;
    })
    .filter(Boolean)
    .join("; ");
}

function isAllowedEmbed(src) {
  try {
    const url = new URL(String(src || ""));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "youtube.com" || host === "www.youtube.com" || host === "youtube-nocookie.com" || host === "www.youtube-nocookie.com") {
      return /^\/embed\/[\w-]+/.test(url.pathname);
    }
    if (host === "discord.com" || host === "www.discord.com" || host === "discordapp.com" || host === "www.discordapp.com") {
      return /^\/widget(\.json)?$/.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

function fallbackSanitize(html) {
  let s = String(html || "");
  s = s.replace(/<(script|style|iframe|object|embed|form|button|textarea|select|option|meta|link|base|svg|math|template|noscript|video|audio|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|form|button|textarea|select|option|meta|link|base|svg|math|template|noscript|video|audio|canvas)\b[^>]*\/?>/gi, "");
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s(srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/(href|src)\s*=\s*("[^"]*javascript:[^"]*"|'[^']*javascript:[^']*'|[^\s>]*javascript:[^\s>]*)/gi, "");
  s = s.replace(/<(?!\/?(a|img|p|br|hr|h[1-6]|ul|ol|li|blockquote|pre|code|strong|em|b|i|del|s|table|thead|tbody|tfoot|tr|th|td|caption|center|details|summary|span|div|section|figure|figcaption|sub|sup|mark|kbd|small|u|input|picture|source|map|area)\b)[^>]*>/gi, "");
  return s;
}

export function sanitizeHtml(html) {
  const source = String(html || "");
  if (!source) return "";
  if (typeof DOMParser === "undefined") return fallbackSanitize(source);
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body><div id="smp-root">${source}</div></body></html>`, "text/html");
  const root = doc.getElementById("smp-root");
  if (!root) return fallbackSanitize(source);

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) { child.remove(); continue; }
      const tag = child.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) { child.remove(); continue; }
      if (!ALLOWED_TAGS.has(tag)) {
        walk(child);
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (name.startsWith("on") || name === "id" || name === "srcdoc" || name === "formaction") {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "style") {
          const clean = sanitizeStyle(value);
          if (clean) child.setAttribute("style", clean);
          else child.removeAttribute(attr.name);
          continue;
        }
        if (name === "class") {
          if (tag === "code" && /^language-[\w+-]+$/.test(value)) continue;
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "href") {
          if (!/^(https?:\/\/|mailto:|[/#])/i.test(value.trim())) child.removeAttribute(attr.name);
          continue;
        }
        if (name === "srcset") {
          const valid = value.split(",").every((part) => /^\s*https?:\/\/\S+(\s+\S+)?\s*$/.test(part));
          if (!valid) child.removeAttribute(attr.name);
          continue;
        }
        if (name === "src") {
          if (!/^https?:\/\//i.test(value.trim())) child.removeAttribute(attr.name);
          continue;
        }
        if (!GLOBAL_ATTRS.has(name)) child.removeAttribute(attr.name);
      }
      if (tag === "a") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      if (tag === "img") {
        child.setAttribute("loading", "lazy");
        child.setAttribute("referrerpolicy", "no-referrer");
        child.setAttribute("decoding", "async");
      }
      if (tag === "input") {
        if ((child.getAttribute("type") || "").toLowerCase() !== "checkbox") {
          child.remove();
          continue;
        }
        child.setAttribute("type", "checkbox");
        child.setAttribute("disabled", "");
        child.removeAttribute("value");
        child.removeAttribute("name");
      }
      if (tag === "iframe") {
        if (!isAllowedEmbed(child.getAttribute("src"))) {
          child.remove();
          continue;
        }
        child.setAttribute("loading", "lazy");
        child.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      }
      const align = (child.getAttribute("align") || "").toLowerCase();
      if (align) {
        if (["left", "center", "right"].includes(align)) {
          const current = child.getAttribute("style") || "";
          const declaration = `text-align: ${align}`;
          const merged = current
            ? (/text-align\s*:/.test(current) ? current.replace(/text-align\s*:[^;]+/, declaration) : `${current}; ${declaration}`)
            : declaration;
          child.setAttribute("style", merged);
        }
        child.removeAttribute("align");
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

export function renderDescription(project) {
  const format = String(project?.description_format || (project?.source === "curseforge" ? "html" : "markdown")).toLowerCase();
  const text = String(project?.body || project?.description || "").trim();
  if (!text) return "";
  if (format === "html") return sanitizeHtml(text);
  if (format === "text") return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  return renderMarkdown(text);
}