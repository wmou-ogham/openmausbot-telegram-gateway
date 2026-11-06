#!/usr/bin/env node
// Unofficial Telegram gateway (adapted from OpenMausBot PR #110, not merged).
// Long-polls Telegram and talks to the harness on loopback as owner.
// Each process is locked to one harness bot (OMB_TELEGRAM_BOT_ID) and one
// Telegram token. bots.csv plus refresh.js starts one instance per row.

import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { loadEnvFile } from "./src/env.js";
import { defaultContextDir, updateContext } from "./src/context.js";
import { gpsFromJpeg } from "./src/exif.js";
import { collectOutbound, resolveSendableFile } from "./src/outbound.js";
import { applyLocation } from "./src/place.js";
import { lookupLink, rememberLink, replyNote, replySource } from "./src/reply.js";
import {
  HTML_MAX,
  RICH_MAX,
  demoteImages,
  markdownToTelegramHtml,
  renderOutgoingMarkdown,
  resolveLocalPhoto,
  richPayload,
  splitOutgoingImages,
} from "./src/format.js";
import { publishLocalImage } from "./src/image-bed.js";
import { createMermaidRenderer, defaultMermaidBin, embedMermaid } from "./src/mermaid.js";
import { createTranscriber } from "./src/stt.js";
import {
  TURN_IMAGE_MAX_COUNT,
  attachmentTag,
  chunkBy,
  composeIncoming,
  formatVoiceTranscript,
  forwardPrefix,
  mediaPlan,
  mimeFromFilePath,
  unsupportedMediaReason,
} from "./src/media.js";

// Some hosts have no IPv6 route to api.telegram.org. Node fetch then fails the
// whole call with ETIMEDOUT and never uses the working IPv4 address.
const HERE = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(HERE, ".env"));
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);

const SERVER = process.env.OMB_SERVER_URL || "http://127.0.0.1:8799";
const DATA_DIR = process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
const IMAGE_PUBLISH_DIR = (process.env.OMB_IMAGE_PUBLISH_DIR || "").trim();
const IMAGE_PUBLIC_BASE = (process.env.OMB_IMAGE_PUBLIC_BASE || "").trim().replace(/\/+$/, "");
const STATE_PATH = process.env.OMB_TELEGRAM_STATE_PATH
  || join(DATA_DIR, "telegram-gateway.json");
const ALLOWED_USERNAME = (process.env.OMB_TELEGRAM_ALLOW_USERNAME || "")
  .replace(/^@/, "")
  .toLowerCase();
const PINNED_BOT_ID = (process.env.OMB_TELEGRAM_BOT_ID || "").trim();
export const TELEGRAM_MAX = RICH_MAX;
/** Telegram rejects empty edits; keep at least this visible while the first tokens arrive. */
const FILE_ROOTS = (process.env.OMB_FILE_ROOTS || `${DATA_DIR}:${homedir()}`).split(":").filter(Boolean);
const TELEGRAM_DOWNLOAD_MAX = 20 * 1024 * 1024;
const CONTEXT_DIR = defaultContextDir(DATA_DIR);
const renderMermaid = createMermaidRenderer({
  bin: (process.env.OMB_MERMAID_BIN || "").trim() || defaultMermaidBin(DATA_DIR),
  cacheDir: join(DATA_DIR, "telegram-mermaid"),
  configPath: join(HERE, "mermaid", "config.json"),
  puppeteerConfigPath: join(HERE, "mermaid", "puppeteer.json"),
  onError: (error) => console.error(`gateway mermaid: ${describeError(error)}`),
});

async function withMermaid(raw) {
  try {
    return await embedMermaid(raw, renderMermaid);
  } catch (error) {
    console.error(`gateway mermaid: ${describeError(error)}`);
    return String(raw ?? "");
  }
}

function rememberContext(patch) {
  try {
    updateContext(CONTEXT_DIR, PINNED_BOT_ID, patch);
  } catch (e) {
    console.error(`telegram context: ${describeError(e)}`);
  }
}

function replyFields(messageId) {
  if (!messageId) return {};
  return { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
}
/** Bot API flood-control: edit in place, never send a second bubble for the same item. */
const EDIT_THROTTLE_MS = 1500;

export function chunkText(text, max = TELEGRAM_MAX) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function backoffMs(failures, base = 2000, ceiling = 60_000) {
  return Math.min(ceiling, base * 2 ** Math.min(failures - 1, 10));
}

export function describeError(e) {
  const err = e;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? e);
}

export function keyboardFor(ask) {
  const id = ask.requestId ?? "";
  if (ask.requestType === "permission") {
    return [[
      { text: "✅ Allow", callback_data: `req:${id}:allow` },
      { text: "❌ Deny", callback_data: `req:${id}:deny` },
    ]];
  }
  const choices = (ask.choices ?? []).slice(0, 5);
  if (!choices.length) {
    return [[{ text: "✍️ Answer in chat (reply to this)", callback_data: `req:${id}:prompt` }]];
  }
  return choices.map((c, i) => [{ text: c.slice(0, 60), callback_data: `req:${id}:choice:${i}` }]);
}

export function askHeader(botName, ask) {
  const kind = ask.requestType === "permission" ? "wants to use" : "asks";
  return `🔐 ${botName} ${kind} ${ask.requestType === "permission" ? ask.tool : "you"}:\n${ask.summary}`;
}

function botToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    if (typeof cfg?.telegram?.token === "string" && cfg.telegram.token) return cfg.telegram.token;
  } catch {
    /* no config */
  }
  console.error("telegram gateway: no TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveState(s) {
  try {
    writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    console.error(`telegram gateway: CANNOT PERSIST STATE to ${STATE_PATH}: ${describeError(e)}`);
  }
}

function isAllowedUser(from) {
  const username = String(from?.username ?? "").replace(/^@/, "").toLowerCase();
  return username === ALLOWED_USERNAME;
}

function isPrivateChat(chat) {
  return chat?.type === "private";
}

async function api(path, init) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text().catch(() => "")}`.trim());
  return await res.json();
}

function telegram(token) {
  const base = `https://api.telegram.org/bot${token}`;
  const call = async (method, payload, attempt = 0) => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({})));
    if (!body.ok) {
      const retryAfter = body.parameters?.retry_after;
      if (typeof retryAfter === "number" && attempt < 4) {
        await new Promise((r) => setTimeout(r, (retryAfter + 0.15) * 1000));
        return call(method, payload, attempt + 1);
      }
      throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
    }
    return body.result;
  };
  return {
    getMe: () => call("getMe", {}),
    deleteWebhook: () => call("deleteWebhook", { drop_pending_updates: false }),
    sendPlain: (chatId, text, keyboard) =>
      call("sendMessage", {
        chat_id: chatId,
        text: text.length ? text : PLACEHOLDER,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    send: async (chatId, text, keyboard, replyToMessageId) => {
      const body = text.length ? text : PLACEHOLDER;
      const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
      const reply = replyFields(replyToMessageId);
      try {
        const result = await call("sendRichMessage", {
          chat_id: chatId,
          rich_message: richPayload(body),
          ...markup,
          ...reply,
        });
        return Object.assign(result, { __format: "rich" });
      } catch (e) {
        console.error(`telegram sendRichMessage: ${describeError(e)}; falling back to HTML`);
        try {
          const result = await call("sendMessage", {
            chat_id: chatId,
            text: markdownToTelegramHtml(body) || PLACEHOLDER,
            parse_mode: "HTML",
            ...markup,
            ...reply,
          });
          return Object.assign(result, { __format: "html" });
        } catch (htmlErr) {
          console.error(`telegram HTML fallback: ${describeError(htmlErr)}; sending plain`);
          const result = await call("sendMessage", {
            chat_id: chatId,
            text: body.slice(0, HTML_MAX) || PLACEHOLDER,
            ...markup,
            ...reply,
          });
          return Object.assign(result, { __format: "plain" });
        }
      }
    },
    edit: async (chatId, messageId, text, format = "rich") => {
      const body = text.length ? text : PLACEHOLDER;
      const editRich = (markdown) => call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        rich_message: richPayload(markdown),
      });
      try {
        if (format === "html") {
          return await call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: markdownToTelegramHtml(body) || PLACEHOLDER,
            parse_mode: "HTML",
          });
        }
        if (format === "plain") {
          return await call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: body,
          });
        }
        try {
          return await editRich(body);
        } catch (e) {
          const fallback = demoteImages(body);
          if (fallback === body || !/PHOTO_URL_INVALID/i.test(describeError(e))) throw e;
          console.error("telegram editMessageText: photo url rejected; sending the text without embedded images");
          return await editRich(fallback);
        }
      } catch (e) {
        if (/not modified/i.test(describeError(e))) return;
        throw e;
      }
    },
    sendPhoto: async (chatId, filePath, caption) => {
      const file = await resolveLocalPhoto(filePath, DATA_DIR);
      const bytes = await readFile(file.path);
      let attempt = 0;
      for (;;) {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("photo", new Blob([bytes], { type: file.mime }), file.name);
        if (caption) form.append("caption", caption.slice(0, 1024));
        const res = await fetch(`${base}/sendPhoto`, { method: "POST", body: form });
        const payload = await res.json().catch(() => ({}));
        if (payload.ok) return payload.result;
        const retryAfter = payload.parameters?.retry_after;
        if (typeof retryAfter === "number" && attempt < 4) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, (retryAfter + 0.15) * 1000));
          continue;
        }
        throw new Error(`telegram sendPhoto: ${payload.description ?? res.status}`);
      }
    },
    sendDocument: async (chatId, filePath, fileName) => {
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", new Blob([bytes]), fileName || "file");
      const res = await fetch(`${base}/sendDocument`, { method: "POST", body: form });
      const payload = await res.json().catch(() => ({}));
      if (!payload.ok) throw new Error(`telegram sendDocument: ${payload.description ?? res.status}`);
      return payload.result;
    },
    sendPlace: (chatId, loc, replyToMessageId) => {
      const reply = replyFields(replyToMessageId);
      if (loc.title || loc.address) {
        return call("sendVenue", {
          chat_id: chatId,
          latitude: loc.latitude,
          longitude: loc.longitude,
          title: (loc.title || "位置").slice(0, 64),
          address: (loc.address || loc.title || "位置").slice(0, 256),
          ...reply,
        });
      }
      return call("sendLocation", {
        chat_id: chatId,
        latitude: loc.latitude,
        longitude: loc.longitude,
        ...reply,
      });
    },
    clearKeyboard: (chatId, messageId) =>
      call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {}),
    answerCallback: (id, text) => call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {}),
    typing: (chatId) => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
    download: async (fileId) => {
      const info = await call("getFile", { file_id: fileId });
      const filePath = info.file_path;
      if (!filePath) throw new Error("telegram getFile: empty file_path");
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
      if (!res.ok) throw new Error(`telegram file download → ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), filePath, fileSize: info.file_size };
    },
    updates: (offset) => call("getUpdates", {
      offset,
      timeout: 50,
      allowed_updates: ["message", "edited_message", "callback_query"],
    }),
  };
}

function requireIdentity() {
  if (!PINNED_BOT_ID) {
    throw new Error("OMB_TELEGRAM_BOT_ID is required. Set it in the instance env or .env. See .env.example.");
  }
  if (!ALLOWED_USERNAME) {
    throw new Error("OMB_TELEGRAM_ALLOW_USERNAME is required. Set it in the instance env or .env. See .env.example.");
  }
}

async function main() {
  requireIdentity();
  const token = botToken();
  const tg = telegram(token);
  const state = loadState();
  state.activeBotId = PINNED_BOT_ID;
  saveState(state);

  const asks = new Map();
  let promptingAsk = null;
  let botCache = [];
  /** One Telegram bubble per OpenMausBot assistant_text item. Deltas edit
   * that bubble; a new item is a new sendMessage. Never null this on throttle. */
  let live = null;
  let lastFinalText = "";
  let replyAnchor = null;
  let liveLock = Promise.resolve();
  const recentOm = [];
  const pendingTg = [];
  const rememberOm = (message) => {
    if (message?.role !== "bot" || message.kind !== "text" || !message.id || !message.text) return;
    const text = String(message.text).trim();
    const index = pendingTg.findIndex((item) => item.text === text);
    if (index >= 0) {
      const [item] = pendingTg.splice(index, 1);
      state.links = rememberLink(state.links, item.tgId, message.id, text);
      saveState(state);
      return;
    }
    recentOm.push({ id: message.id, text });
    if (recentOm.length > 30) recentOm.shift();
  };
  const rememberTg = (tgId, text) => {
    const wanted = String(text ?? "").trim();
    if (!tgId || !wanted) return;
    const hit = [...recentOm].reverse().find((item) => item.text === wanted);
    if (hit) {
      state.links = rememberLink(state.links, tgId, hit.id, wanted);
      saveState(state);
      return;
    }
    pendingTg.push({ tgId, text: wanted });
    if (pendingTg.length > 30) pendingTg.shift();
  };
  const deliverSideEffects = async (chatId, raw) => {
    const side = collectOutbound(raw);
    for (const loc of side.locations) {
      try {
        await tg.sendPlace(chatId, loc, replyAnchor);
      } catch (e) {
        console.error(`gateway place: ${describeError(e)}`);
        await tg.sendPlain(chatId, `⚠️ 位置沒送到 Telegram：${describeError(e)}`);
      }
    }
    for (const file of side.files) {
      try {
        const resolved = await resolveSendableFile(file.path, FILE_ROOTS);
        await tg.sendDocument(chatId, resolved.path, file.name || resolved.name);
      } catch (e) {
        console.error(`gateway file: ${describeError(e)}`);
        const name = file.name || basename(file.path);
        await tg.sendPlain(chatId, `⚠️ 檔案沒送到 Telegram：${name}`);
      }
    }
  };
  let typingTimer = null;

  const stopTyping = () => {
    if (typingTimer) clearInterval(typingTimer);
    typingTimer = null;
  };
  const startTyping = (chatId) => {
    if (!chatId) return;
    void tg.typing(chatId);
    if (typingTimer) return;
    typingTimer = setInterval(() => {
      const id = state.ownerChatId;
      if (id) void tg.typing(id);
    }, 4000);
    typingTimer.unref?.();
  };
  const withLive = (fn) => {
    liveLock = liveLock.then(fn).catch((e) => {
      console.error(`gateway live: ${describeError(e)}`);
    });
    return liveLock;
  };
  const clearLiveTimer = () => {
    if (live?.timer) {
      clearTimeout(live.timer);
      live.timer = undefined;
    }
  };
  const shownChunks = (text, max = RICH_MAX) => {
    const chunks = chunkText(text.length ? text : PLACEHOLDER, max);
    return chunks.length ? chunks : [PLACEHOLDER];
  };
  const liveMax = () => (live?.format === "html" || live?.format === "plain" ? HTML_MAX : RICH_MAX);
  const ensurePublished = async (raw) => {
    const prepared = await withMermaid(raw);
    const { images } = splitOutgoingImages(prepared);
    if (!live.published) live.published = new Map();
    if (IMAGE_PUBLISH_DIR && IMAGE_PUBLIC_BASE) {
      for (const image of images) {
        if (live.published.has(image.path)) continue;
        try {
          const published = await publishLocalImage(image.path, {
            dataDir: DATA_DIR,
            publishDir: IMAGE_PUBLISH_DIR,
            publicBase: IMAGE_PUBLIC_BASE,
          });
          live.published.set(image.path, published.url);
        } catch (error) {
          console.error(`gateway image publish: ${describeError(error)}`);
        }
      }
    }
    return renderOutgoingMarkdown(prepared, (path) => live.published.get(path) ?? null);
  };
  const applyLiveEdit = async (chatId) => {
    if (!live) return;
    const visibleSource = await ensurePublished(live.text);
    const visible = collectOutbound(visibleSource).text;
    if (!visible.trim()) return;
    const chunks = shownChunks(visible, live.messageId ? liveMax() : RICH_MAX);
    const head = chunks[0];
    if (!live.messageId) {
      const sent = await tg.send(chatId, head, undefined, live.replyTo);
      live.messageId = sent.message_id;
      live.posted = head;
      live.lastEditAt = Date.now();
      live.overflow = [];
      live.format = sent.__format ?? "rich";
    } else if (head !== live.posted) {
      await tg.edit(chatId, live.messageId, head, live.format);
      live.posted = head;
      live.lastEditAt = Date.now();
    }
    live.overflow ??= [];
    const tail = chunks.slice(1);
    for (let i = live.overflow.length; i < tail.length; i++) {
      const sent = await tg.send(chatId, tail[i]);
      live.overflow.push({
        messageId: sent.message_id,
        posted: tail[i],
        format: sent.__format ?? live.format,
      });
    }
    for (let i = 0; i < tail.length; i++) {
      const slot = live.overflow[i];
      if (slot && slot.posted !== tail[i]) {
        await tg.edit(chatId, slot.messageId, tail[i], slot.format ?? live.format);
        slot.posted = tail[i];
        live.lastEditAt = Date.now();
      }
    }
  };
  const photoFailureNote = (filePath, error) => {
    const name = basename(filePath);
    const msg = describeError(error);
    if (/ENOENT|missing/i.test(msg)) return `⚠️ 圖片讀不到：${name}`;
    if (/outside data dir/i.test(msg)) return `⚠️ 圖片不在資料目錄，沒有傳送：${name}`;
    if (/too large/i.test(msg)) return `⚠️ 圖片超過 10MB，沒有傳送：${name}`;
    return `⚠️ 圖片沒送出：${name}`;
  };
  const flushLocalPhotos = async (chatId, raw) => {
    if (!live) return;
    const prepared = await withMermaid(raw);
    const { images } = splitOutgoingImages(prepared);
    for (const image of images) {
      if (live.published?.has(image.path) || live.sentPhotoPaths.has(image.path)) continue;
      live.sentPhotoPaths.add(image.path);
      try {
        await tg.sendPhoto(chatId, image.path, image.alt);
      } catch (e) {
        console.error(`gateway photo: ${describeError(e)}`);
        await tg.sendPlain(chatId, photoFailureNote(image.path, e));
      }
    }
  };
  const scheduleLiveEdit = (chatId) => {
    if (!live || live.timer) return;
    const due = Math.max(0, EDIT_THROTTLE_MS - (Date.now() - (live.lastEditAt ?? 0)));
    live.timer = setTimeout(() => {
      if (live) live.timer = undefined;
      void withLive(async () => {
        try {
          await applyLiveEdit(chatId);
        } catch (e) {
          console.error(`gateway edit: ${describeError(e)}`);
        }
      });
    }, due);
    live.timer.unref?.();
  };
  const openLive = async (chatId, text) => {
    live = {
      messageId: null,
      text,
      posted: "",
      lastEditAt: 0,
      overflow: [],
      format: "rich",
      sentPhotoPaths: new Set(),
      published: new Map(),
      replyTo: replyAnchor,
    };
    await applyLiveEdit(chatId);
  };
  const onAssistantDelta = async (chatId, delta) => {
    if (!delta) return;
    stopTyping();
    await withLive(async () => {
      if (!live) {
        await openLive(chatId, delta);
        return;
      }
      live.text += delta;
      scheduleLiveEdit(chatId);
    });
  };
  const finishAssistantItem = async (chatId, text) => {
    const finalText = String(text ?? "");
    await withLive(async () => {
      if (live) {
        live.text = finalText.length ? finalText : live.text;
        clearLiveTimer();
        try {
          await applyLiveEdit(chatId);
        } catch (e) {
          console.error(`gateway edit: ${describeError(e)}`);
        }
        try {
          await flushLocalPhotos(chatId, live.text);
        } catch (e) {
          console.error(`gateway photo: ${describeError(e)}`);
        }
        try {
          await deliverSideEffects(chatId, live.text);
        } catch (e) {
          console.error(`gateway side: ${describeError(e)}`);
        }
        rememberTg(live.messageId, live.text);
        for (const slot of live.overflow ?? []) rememberTg(slot.messageId, live.text);
        lastFinalText = live.text;
        live = null;
        return;
      }
      if (!finalText.trim()) return;
      if (finalText === lastFinalText) return;
      await openLive(chatId, finalText);
      try {
        await flushLocalPhotos(chatId, finalText);
      } catch (e) {
        console.error(`gateway photo: ${describeError(e)}`);
      }
      try {
        await deliverSideEffects(chatId, finalText);
      } catch (e) {
        console.error(`gateway side: ${describeError(e)}`);
      }
      if (live) {
        rememberTg(live.messageId, finalText);
        for (const slot of live.overflow ?? []) rememberTg(slot.messageId, finalText);
      }
      lastFinalText = finalText;
      live = null;
    });
  };
  const closeLiveIfAny = async (chatId) => {
    await withLive(async () => {
      if (!live) return;
      clearLiveTimer();
      try {
        await applyLiveEdit(chatId);
      } catch (e) {
        console.error(`gateway edit: ${describeError(e)}`);
      }
      try {
        await flushLocalPhotos(chatId, live.text);
      } catch (e) {
        console.error(`gateway photo: ${describeError(e)}`);
      }
      try {
        await deliverSideEffects(chatId, live.text);
      } catch (e) {
        console.error(`gateway side: ${describeError(e)}`);
      }
      rememberTg(live.messageId, live.text);
      for (const slot of live.overflow ?? []) rememberTg(slot.messageId, live.text);
      lastFinalText = live.text;
      live = null;
    });
  };

  const refreshBots = async () => {
    botCache = (await api("/api/bots")).bots ?? [];
    return botCache;
  };
  const pinnedBot = async () => {
    const bots = await refreshBots();
    const bot = bots.find((b) => b.id === PINNED_BOT_ID);
    if (!bot) throw new Error(`pinned bot ${PINNED_BOT_ID} is not on the harness`);
    if (state.activeBotId !== bot.id) {
      state.activeBotId = bot.id;
      saveState(state);
    }
    return bot;
  };
  const botForThread = async (threadId) => {
    const hit = botCache.find((b) => b.threadId === threadId)
      ?? botCache.find((b) => (b.tasks ?? []).some((t) => t.threadId === threadId));
    if (hit) return hit;
    await refreshBots();
    return botCache.find((b) => b.threadId === threadId)
      ?? botCache.find((b) => (b.tasks ?? []).some((t) => t.threadId === threadId));
  };

  const transcriber = createTranscriber({ dataDir: DATA_DIR });
  const transcribeBytes = async (bytes, name) => {
    const dir = await mkdtemp(join(tmpdir(), "tg-stt-"));
    const path = join(dir, name || "voice.ogg");
    try {
      await writeFile(path, bytes);
      try {
        return await transcriber.transcribe(path);
      } catch (error) {
        throw new Error(`語音轉文字失敗：${describeError(error)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const uploadBytes = async (kind, bytes, mime, name) => {
    if (kind === "image") {
      const res = await fetch(`${SERVER}/api/attachments`, {
        method: "POST",
        headers: { "content-type": mime, "content-length": String(bytes.byteLength) },
        body: bytes,
      });
      if (!res.ok) throw new Error(`/api/attachments → ${res.status} ${await res.text().catch(() => "")}`.trim());
      return await res.json();
    }
    const qs = new URLSearchParams({ name });
    const res = await fetch(`${SERVER}/api/files?${qs}`, {
      method: "POST",
      headers: { "content-type": mime, "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    if (!res.ok) throw new Error(`/api/files → ${res.status} ${await res.text().catch(() => "")}`.trim());
    return await res.json();
  };

  const ingestPlan = async (plan) => {
    const tags = [];
    const transcripts = [];
    let fallback = plan[0]?.label ?? "（附件）";
    for (const item of plan) {
      if (typeof item.fileSize === "number" && item.fileSize > TELEGRAM_DOWNLOAD_MAX) {
        throw new Error("檔案超過 Telegram 可下載的 20MB");
      }
      const file = await tg.download(item.fileId);
      if (file.bytes.byteLength > TELEGRAM_DOWNLOAD_MAX) throw new Error("檔案超過 Telegram 可下載的 20MB");
      if (item.transcribe) {
        const text = await transcribeBytes(file.bytes, item.suggestedName);
        transcripts.push(formatVoiceTranscript(item.suggestedName, text));
        fallback = item.label;
        continue;
      }
      const mime = mimeFromFilePath(file.filePath, item.mime);
      const saved = await uploadBytes(item.kind, file.bytes, mime, item.suggestedName);
      tags.push(attachmentTag(item.kind, saved.path, saved.name ?? item.suggestedName));
      fallback = item.label;
      if (item.kind === "image") {
        const gps = gpsFromJpeg(file.bytes);
        if (gps) {
          rememberContext({
            photo: {
              at: Date.now(),
              name: saved.name ?? item.suggestedName,
              path: saved.path,
              latitude: gps.latitude,
              longitude: gps.longitude,
            },
          });
        }
      }
    }
    return { tags, transcripts, fallback };
  };

  const postToBot = async (chatId, text, extra = {}) => {
    const bot = await pinnedBot();
    startTyping(chatId);
    const payload = { text, origin: "telegram" };
    if (extra.replyToId) payload.replyToId = extra.replyToId;
    const receipt = await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify(payload) });
    if (extra.tgMessageId) replyAnchor = extra.tgMessageId;
    if (extra.tgMessageId && receipt.message?.id) {
      state.links = rememberLink(state.links, extra.tgMessageId, receipt.message.id, text);
      saveState(state);
    }
    return receipt;
  };

  const deliverMedia = async (chatId, msg, plan) => {
    const images = plan.filter((p) => p.kind === "image");
    const files = plan.filter((p) => p.kind !== "image");
    const imageGroups = chunkBy(images, TURN_IMAGE_MAX_COUNT);
    const batches = imageGroups.length
      ? imageGroups.map((group, i) => (i === 0 ? [...group, ...files] : group))
      : [files];
    const prefix = forwardPrefix(msg);
    const caption = String(msg.caption ?? msg.text ?? "").trim();
    const source = replySource(msg);
    const linked = lookupLink(state.links, source?.tgId);
    const quoted = replyNote(source, Boolean(linked));
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (!batch.length) continue;
      const { tags, transcripts, fallback } = await ingestPlan(batch);
      // OpenMaus repeats 「語音轉譯」 in its reply. Posting it here would show the same text twice.
      await postToBot(chatId, composeIncoming({
        prefix: i === 0 ? prefix : "",
        replyNote: i === 0 ? quoted : "",
        caption: i === 0 ? caption : "",
        tags,
        transcripts,
        fallback,
      }), {
        replyToId: i === 0 ? linked : undefined,
        tgMessageId: i === 0 ? msg.message_id : undefined,
      });
    }
  };

  const albums = new Map();
  const flushAlbum = async (groupId) => {
    const bucket = albums.get(groupId);
    if (!bucket) return;
    albums.delete(groupId);
    if (bucket.timer) clearTimeout(bucket.timer);
    try {
      await deliverMedia(bucket.chatId, bucket.msg, bucket.plan);
    } catch (e) {
      console.error(`gateway album: ${describeError(e)}`);
      await tg.send(bucket.chatId, `⚠️ 附件沒送進 OpenMausBot：${describeError(e)}`);
    }
  };
  const queueAlbum = (chatId, msg, plan) => {
    const id = String(msg.media_group_id);
    let bucket = albums.get(id);
    if (!bucket) {
      bucket = { chatId, msg, plan: [], timer: null };
      albums.set(id, bucket);
    }
    bucket.plan.push(...plan);
    if (msg.caption) bucket.msg = { ...bucket.msg, caption: msg.caption };
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => void flushAlbum(id), 700);
    bucket.timer.unref?.();
  };

  const handleBroadcast = async (payload) => {
    if (payload.kind === "message") {
      rememberOm(payload.message);
      return;
    }
    const chatId = state.ownerChatId;
    if (!chatId || payload.kind !== "runtime") return;
    const event = payload.event ?? {};
    const eventBot = await botForThread(event.threadId);
    if (!eventBot || eventBot.id !== PINNED_BOT_ID) return;

    switch (event.type) {
      case "turn.started":
        lastFinalText = "";
        startTyping(chatId);
        break;
      case "content.delta":
        if (event.streamKind === "assistant_text" && event.delta) {
          await onAssistantDelta(chatId, event.delta);
        } else if (event.streamKind === "reasoning_text") {
          startTyping(chatId);
        }
        break;
      case "item.started":
        if (!live) startTyping(chatId);
        break;
      case "item.completed":
        if (event.itemType === "assistant_text" && event.text) {
          await finishAssistantItem(chatId, event.text);
          startTyping(chatId);
        } else if (event.itemType === "tool") {
          startTyping(chatId);
        }
        break;
      case "request.opened": {
        const ask = {
          requestId: event.requestId,
          requestType: event.requestType === "question" ? "question" : "permission",
          tool: event.tool ?? "tool",
          summary: event.summary ?? "",
          choices: event.choices,
        };
        const sent = await tg.send(chatId, askHeader(eventBot.name, ask), keyboardFor(ask));
        console.log(`telegram gateway: sent ${ask.requestType} card for ${eventBot.name} (${ask.tool}) → message ${sent.message_id}`);
        if (ask.requestId) asks.set(ask.requestId, { messageId: sent.message_id, ask, botId: eventBot.id });
        break;
      }
      case "request.resolved": {
        const pending = event.requestId ? asks.get(event.requestId) : undefined;
        if (pending) {
          asks.delete(event.requestId);
          await tg.clearKeyboard(chatId, pending.messageId);
          if (event.source !== "user") await tg.send(chatId, `⏱️ Resolved without you: ${event.behavior}`);
        }
        break;
      }
      case "turn.completed": {
        stopTyping();
        await closeLiveIfAny(chatId);
        if (event.ok === false) await tg.send(chatId, `⚠️ ${eventBot.name}: turn failed (${event.stopReason ?? "unknown"})`);
        break;
      }
      case "runtime.error":
        if (event.message) await tg.send(chatId, `⚠️ ${String(event.message).slice(0, 300)}`);
        break;
      default:
        break;
    }
  };

  const consumeEvents = async () => {
    let failures = 0;
    for (;;) {
      try {
        const res = await fetch(`${SERVER}/api/events`);
        if (!res.body) throw new Error("no body");
        console.log(`telegram gateway: event stream connected${failures ? ` (after ${failures} failed attempt(s))` : ""}`);
        failures = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            let payload;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            await handleBroadcast(payload).catch((e) => console.error("gateway handle:", describeError(e)));
          }
        }
        failures += 1;
      } catch (e) {
        failures += 1;
        if (failures <= 3 || failures % 10 === 0) {
          console.error(`gateway SSE (attempt ${failures}): ${describeError(e)}`);
        }
      }
      stopTyping();
      await new Promise((r) => setTimeout(r, backoffMs(failures)));
    }
  };

  const refuse = async (chatId, reason) => {
    try {
      await tg.send(chatId, reason);
    } catch {
      /* ignore */
    }
  };

  const handleUpdate = async (u) => {
    const edited = u.edited_message;
    const msg = u.message ?? edited;
    const cb = u.callback_query;
    const chat = msg?.chat ?? cb?.message?.chat;
    const from = msg?.from ?? cb?.from;
    const chatId = chat?.id;
    if (!chatId) return;

    if (!isPrivateChat(chat) || !isAllowedUser(from)) {
      if (msg && isPrivateChat(chat)) {
        const who = String(from?.username ?? "").replace(/^@/, "") || "(no username)";
        console.log(`telegram gateway: refused @${who} id ${from?.id ?? "?"}`);
        await refuse(chatId, `This gateway only talks to @${ALLOWED_USERNAME}.`);
      }
      return;
    }

    if (state.ownerChatId !== chatId) {
      state.ownerChatId = chatId;
      state.ownerUsername = from.username;
      saveState(state);
      console.log(`telegram gateway: bound to @${from.username} chat ${chatId}`);
    }

    if (cb) {
      const [kind, ...rest] = String(cb.data ?? "").split(":");
      if (kind === "bot") {
        const bot = await pinnedBot();
        await tg.answerCallback(cb.id, `Locked to ${bot.name}`);
        await tg.send(chatId, `This Telegram bot only talks to ${bot.name}. Just type.`);
        return;
      }
      if (kind === "req") {
        const [requestId, action, choiceIx] = rest;
        const pending = asks.get(requestId);
        if (!pending) {
          await tg.answerCallback(cb.id, "Already resolved");
          return;
        }
        if (pending.botId !== PINNED_BOT_ID) {
          await tg.answerCallback(cb.id, "Ignored");
          return;
        }
        if (action === "prompt") {
          promptingAsk = requestId;
          await tg.answerCallback(cb.id, "Reply with your answer");
          await tg.send(chatId, "✍️ Type your answer:");
          return;
        }
        const body = action === "choice"
          ? { requestId, behavior: "answer", message: pending.ask.choices?.[Number(choiceIx)] ?? "" }
          : { requestId, behavior: action };
        try {
          await api(`/api/bots/${pending.botId}/respond`, { method: "POST", body: JSON.stringify(body) });
        } catch (e) {
          console.error(`gateway respond: ${describeError(e)}`);
          await tg.answerCallback(cb.id, "Could not deliver — try again");
          await tg.send(chatId, `⚠️ Your answer did not reach ${pending.ask.tool}: ${describeError(e)}`);
          return;
        }
        await tg.answerCallback(cb.id, action === "deny" ? "Denied" : "Sent");
      }
      return;
    }

    if (edited) {
      if (msg.location || msg.venue) {
        const applied = applyLocation(state.liveLocation, msg);
        state.liveLocation = applied.state;
        saveState(state);
        rememberContext({ location: applied.state });
        if (applied.state?.stopped) await tg.send(chatId, "Live location stopped.");
      }
      return;
    }

    if (msg?.location || msg?.venue) {
      const applied = applyLocation(state.liveLocation, msg);
      state.liveLocation = applied.state;
      saveState(state);
      rememberContext({ location: applied.state });
      const note = applied.state?.active
        ? "Saved your live location. I'll only read it when you ask where you are."
        : "Saved this location. I'll use it when it's needed.";
      await tg.send(chatId, note);
      return;
    }

    const plan = mediaPlan(msg);
    if (plan.length) {
      startTyping(chatId);
      if (msg.media_group_id) {
        queueAlbum(chatId, msg, plan);
        return;
      }
      try {
        await deliverMedia(chatId, msg, plan);
      } catch (e) {
        console.error(`gateway media: ${describeError(e)}`);
        await tg.send(chatId, `⚠️ 附件沒送進 OpenMausBot：${describeError(e)}`);
      }
      return;
    }

    const text = String(msg?.text ?? "").trim();
    if (!text) {
      const why = unsupportedMediaReason(msg);
      if (why) await tg.send(chatId, why);
      return;
    }

    if (text.startsWith("/start") || text.startsWith("/bots")) {
      const bot = await pinnedBot();
      await tg.send(
        chatId,
        `This Telegram bot only talks to ${bot.name} (${bot.modelSelection?.model ?? "model"}).\nJust type. /stop interrupts the current turn.`,
      );
      return;
    }
    if (text.startsWith("/stop")) {
      const bot = await pinnedBot();
      await api(`/api/bots/${bot.id}/interrupt`, { method: "POST", body: "{}" });
      await tg.send(chatId, `🛑 Stopped ${bot.name}.`);
      return;
    }
    if (promptingAsk) {
      const pending = asks.get(promptingAsk);
      promptingAsk = null;
      if (pending && pending.botId === PINNED_BOT_ID) {
        try {
          await api(`/api/bots/${pending.botId}/respond`, {
            method: "POST",
            body: JSON.stringify({ requestId: pending.ask.requestId, behavior: "answer", message: text }),
          });
          await tg.send(chatId, "Answer sent.");
        } catch (e) {
          console.error(`gateway respond: ${describeError(e)}`);
          await tg.send(chatId, `⚠️ Your answer did not get through: ${describeError(e)}`);
        }
        return;
      }
    }
    const source = replySource(msg);
    const linked = lookupLink(state.links, source?.tgId);
    const outbound = [forwardPrefix(msg), replyNote(source, Boolean(linked)), text].filter(Boolean).join("\n");
    try {
      await postToBot(chatId, outbound, { replyToId: linked, tgMessageId: msg.message_id });
    } catch (e) {
      console.error(`gateway text: ${describeError(e)}`);
      await tg.send(chatId, `⚠️ 訊息沒送進 OpenMausBot：${describeError(e)}`);
    }
  };

  const consumeUpdates = async () => {
    let offset = 0;
    let failures = 0;
    for (;;) {
      try {
        const updates = await tg.updates(offset);
        if (failures) {
          console.log(`telegram gateway: polling recovered after ${failures} failed attempt(s)`);
          failures = 0;
        }
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(u).catch((e) => console.error("gateway update:", describeError(e)));
        }
      } catch (e) {
        failures += 1;
        if (failures <= 3 || failures % 10 === 0) {
          console.error(`gateway poll (attempt ${failures}): ${describeError(e)}`);
        }
        await new Promise((r) => setTimeout(r, backoffMs(failures)));
      }
    }
  };

  await api("/api/health");
  await tg.deleteWebhook().catch(() => {});
  const me = await tg.getMe();
  const bot = await pinnedBot();
  console.log(`telegram gateway: @${me.username} → ${SERVER} bot ${bot.name} (${bot.id}); allow @${ALLOWED_USERNAME}`);
  rememberContext({ botName: bot.name });
  await Promise.all([consumeEvents(), consumeUpdates()]);
}

const invoked = process.argv[1] && /telegram-gateway|gateway\.js$/.test(process.argv[1]);
if (invoked) {
  main().catch((e) => {
    console.error("telegram gateway:", e);
    process.exit(1);
  });
}
