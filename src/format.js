import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative } from "node:path";

// Convert OpenMausBot Markdown to Telegram rich-message Markdown, or HTML fallback.
// Classic sendMessage parse_mode never had GFM tables/headings.
// Bot API 10.1+ sendRichMessage { markdown } does: https://core.telegram.org/bots/api#rich-message-formatting-options

export const RICH_MAX = 32768;
export const HTML_MAX = 4096;

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += c > 0x2e80 ? 2 : 1;
  }
  return w;
}

export function isTableSeparator(line) {
  return TABLE_SEP.test(line);
}

export function parsePipeRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function formatAlignedTable(lines) {
  const rows = lines
    .filter((l) => !isTableSeparator(l))
    .map(parsePipeRow);
  if (!rows.length) return lines.join("\n");
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, i) =>
    Math.max(1, ...rows.map((r) => displayWidth(r[i] ?? ""))),
  );
  const pad = (cell, i) => {
    const text = cell ?? "";
    return text + " ".repeat(Math.max(0, widths[i] - displayWidth(text)));
  };
  return rows.map((r) => r.map(pad).join("  ").trimEnd()).join("\n");
}

function takeTable(lines, start) {
  let i = start;
  if (!TABLE_ROW.test(lines[i] ?? "")) return null;
  const block = [lines[i]];
  i += 1;
  if (!isTableSeparator(lines[i] ?? "")) return null;
  block.push(lines[i]);
  i += 1;
  while (i < lines.length && TABLE_ROW.test(lines[i])) {
    block.push(lines[i]);
    i += 1;
  }
  return { end: i, lines: block };
}

/** Close unfinished fences / ** so Telegram's GFM parser won't 400 mid-stream. */
export function stabilizeMarkdown(text) {
  let s = String(text ?? "");
  if (!s.trim()) return s;
  const lines = s.split("\n");
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
  }
  if (inFence) s += "\n```";

  const last = s.split("\n").at(-1) ?? "";
  if (/^\s*\|[^\n]*[^|]\s*$/.test(last) && !isTableSeparator(last)) s += " |";

  const withoutFences = s.replace(/```[\s\S]*?```/g, "");
  const boldMarks = withoutFences.match(/\*\*/g)?.length ?? 0;
  if (boldMarks % 2 === 1) s += "**";
  return s;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineToHtml(raw) {
  const escaped = escapeHtml(raw);
  const slots = [];
  const park = (html) => {
    const key = `\u0000${slots.length}\u0000`;
    slots.push(html);
    return key;
  };
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, (_, code) => park(`<code>${code}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    park(`<a href="${url.replace(/"/g, "")}">${label}</a>`));
  s = s.replace(/\*\*(.+?)\*\*/g, (_, t) => park(`<b>${t}</b>`));
  s = s.replace(/__(.+?)__/g, (_, t) => park(`<b>${t}</b>`));
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, (_, pre, t) => `${pre}${park(`<i>${t}</i>`)}`);
  s = s.replace(/~~(.+?)~~/g, (_, t) => park(`<s>${t}</s>`));
  for (let i = 0; i < slots.length; i++) s = s.replace(`\u0000${i}\u0000`, slots[i]);
  return s;
}

function headingToHtml(line) {
  const m = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!m) return null;
  return `<b>${inlineToHtml(m[2])}</b>`;
}

/** Classic sendMessage HTML fallback when sendRichMessage is unavailable. */
export function markdownToTelegramHtml(text) {
  const src = String(text ?? "");
  if (!src.trim()) return src;
  const out = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }
    const table = takeTable(lines, i);
    if (table) {
      out.push(`<pre>${escapeHtml(formatAlignedTable(table.lines))}</pre>`);
      i = table.end;
      continue;
    }
    const heading = headingToHtml(line);
    if (heading) {
      out.push(heading);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      i += 1;
      continue;
    }
    out.push(inlineToHtml(line));
    i += 1;
  }
  return out.join("\n");
}

export function richPayload(text) {
  return { markdown: stabilizeMarkdown(text) };
}

const COMPLETE_IMAGE = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const INCOMPLETE_LOCAL_IMAGE = /!\[[^\]]*\]\((?:file:\/\/|\/)[^)\n]*$/;
/** Telegram sendPhoto multipart limit for photos. */
export const LOCAL_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const PHOTO_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Remote rich-message media stays embedded. Anything else is not a URL Telegram can fetch. */
export function classifyImageTarget(raw) {
  let target = String(raw ?? "").trim();
  const titled = target.match(/^(.*\S)\s+"[^"]*"\s*$/);
  if (titled) target = titled[1].trim();
  if (/^(https?:\/\/|tg:)/i.test(target)) return { kind: "remote" };
  if (/^file:\/\//i.test(target)) {
    try {
      target = decodeURIComponent(target.slice("file://".length));
    } catch {
      return { kind: "drop" };
    }
  }
  if (target.startsWith("/") && !target.includes("\0")) return { kind: "local", path: target };
  return { kind: "drop" };
}

function rewriteImageLine(line, images, stripIncomplete, urlForPath) {
  let next = line.replace(COMPLETE_IMAGE, (full, alt, target) => {
    const kind = classifyImageTarget(target);
    if (kind.kind === "remote") return full;
    if (kind.kind === "local") {
      const label = String(alt ?? "").trim();
      if (images) images.push({ alt: label, path: kind.path });
      const url = urlForPath?.(kind.path);
      if (url) return `![${label}](${url})`;
    }
    return "";
  });
  if (stripIncomplete) next = next.replace(INCOMPLETE_LOCAL_IMAGE, "");
  return next;
}

function walkImageLines(text, images, urlForPath) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(rewriteImageLine(line, images, i === lines.length - 1, urlForPath));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Pull local `![alt](/path)` out of assistant Markdown.
 * https and tg:// images stay inline. The returned text is what Telegram may edit
 * without RICH_MESSAGE_PHOTO_URL_INVALID; `images` are uploaded afterwards.
 */
export function splitOutgoingImages(text) {
  const images = [];
  return { text: walkImageLines(text, images), images };
}

/** Replace a published local image with its public URL. Unpublished locals are removed. */
export function renderOutgoingMarkdown(text, urlForPath) {
  return walkImageLines(text, null, urlForPath);
}

/** Turn embedded images into links or plain alt text so one bad URL cannot reject the edit. */
export function demoteImages(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(line.replace(COMPLETE_IMAGE, (full, alt, target) => {
      const kind = classifyImageTarget(target);
      const label = String(alt ?? "").trim();
      if (kind.kind === "remote") {
        const url = String(target).trim().split(/\s+/)[0];
        return label ? `[${label}](${url})` : url;
      }
      return label;
    }));
  }
  return out.join("\n");
}

/** Real image file inside dataDir, or throw. Rejects symlink escapes. */
export async function resolveLocalPhoto(filePath, dataDir) {
  const root = await realpath(dataDir);
  let resolved;
  try {
    resolved = await realpath(filePath);
  } catch (error) {
    const missing = new Error("missing");
    missing.cause = error;
    throw missing;
  }
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("outside data dir");
  const mime = PHOTO_MIME[extname(resolved).toLowerCase()];
  if (!mime) throw new Error("not an image");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size <= 0 || info.size > LOCAL_PHOTO_MAX_BYTES) throw new Error("too large");
  return { path: resolved, mime, name: basename(resolved), size: info.size };
}
