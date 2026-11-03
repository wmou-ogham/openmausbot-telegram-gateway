/** Per-bot Telegram facts the model can read later. Coordinates stay here
 * instead of being copied into every OpenMaus message. */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ID = /^[\w-]+$/;
const PHOTO_CAP = 30;

export function defaultContextDir(dataDir = process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot")) {
  return process.env.TELEGRAM_CONTEXT_DIR || join(dataDir, "telegram-context");
}

function fileFor(dir, botId) {
  if (!ID.test(botId)) throw new Error("bad bot id");
  return join(dir, `${botId}.json`);
}

export function readContext(dir, botId) {
  if (!ID.test(botId)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fileFor(dir, botId), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listContexts(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readContext(dir, name.slice(0, -5)))
    .filter(Boolean);
}

export function updateContext(dir, botId, patch = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = readContext(dir, botId) ?? { botId, photos: [] };
  const next = {
    botId,
    botName: patch.botName ?? current.botName ?? "",
    location: patch.location === undefined ? (current.location ?? null) : patch.location,
    photos: Array.isArray(current.photos) ? current.photos : [],
    updatedAt: Date.now(),
  };
  if (patch.photo?.path) {
    next.photos = [patch.photo, ...next.photos.filter((item) => item.path !== patch.photo.path)].slice(0, PHOTO_CAP);
  }
  const path = fileFor(dir, botId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}
