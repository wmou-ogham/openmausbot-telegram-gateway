import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative } from "node:path";
import { takeLocations } from "./place.js";

const FILE_TAG = /<attached-file[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>/g;
const LOCAL_LINK = /(^|[^!])\[([^\]]*)\]\(([^)\n]+)\)/g;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
export const SEND_FILE_MAX_BYTES = 45 * 1024 * 1024;

function decode(value) {
  return String(value ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function localPath(raw) {
  let target = String(raw ?? "").trim();
  const titled = target.match(/^(.*\S)\s+"[^"]*"\s*$/);
  if (titled) target = titled[1].trim();
  if (/^file:\/\//i.test(target)) {
    try {
      target = decodeURIComponent(target.slice("file://".length));
    } catch {
      return null;
    }
  }
  if (!target.startsWith("/") || target.includes("\0") || target.includes("\n")) return null;
  return target;
}

function hidePartial(text) {
  return String(text ?? "")
    .replace(/<telegram-location\b[^>\n]*$/g, "")
    .replace(/<attached-file\b[^>\n]*$/g, "");
}

export function collectOutbound(text) {
  const located = takeLocations(hidePartial(text));
  const files = [];
  let cleaned = located.text.replace(FILE_TAG, (full, path, name) => {
    files.push({ path: decode(path), name: decode(name || "") });
    return "";
  });
  cleaned = cleaned.replace(LOCAL_LINK, (full, prefix, label, target) => {
    const path = localPath(target);
    if (!path || IMAGE_EXT.has(extname(path).toLowerCase())) return full;
    files.push({ path, name: String(label ?? "").trim() });
    return `${prefix}${String(label ?? "").trim()}`;
  });
  return {
    text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    locations: located.locations,
    files,
  };
}

function blocked(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return ["/.ssh/", "/.gnupg/", "/.aws/", "/.config/"].some((part) => normalized.includes(part));
}

/** A regular file inside one allowed root. Symlinks may not escape that root. */
export async function resolveSendableFile(filePath, roots) {
  if (!filePath || blocked(filePath)) throw new Error("outside file roots");
  let resolved;
  try {
    resolved = await realpath(filePath);
  } catch (error) {
    const missing = new Error("missing");
    missing.cause = error;
    throw missing;
  }
  if (blocked(resolved)) throw new Error("outside file roots");
  const allowed = [];
  for (const root of roots) {
    try {
      allowed.push(await realpath(root));
    } catch {
      /* a missing optional root does not widen access */
    }
  }
  const inside = allowed.some((root) => {
    const rel = relative(root, resolved);
    return rel && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inside) throw new Error("outside file roots");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size <= 0 || info.size > SEND_FILE_MAX_BYTES) throw new Error("too large");
  return { path: resolved, name: basename(resolved), size: info.size };
}
