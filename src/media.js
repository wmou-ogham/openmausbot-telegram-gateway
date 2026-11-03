/** Telegram inbound photo/voice → OpenMausBot composer attachment tags. */

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AUDIO_MIMES = new Set([
  "audio/opus", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/x-m4a",
  "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/flac",
  "audio/x-flac", "audio/webm",
]);

const MIME_FROM_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
};

export const TURN_IMAGE_MAX_COUNT = 4;

export function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

export function attachmentTag(kind, path, name) {
  const tag = kind === "image" ? "attached-image" : "attached-file";
  return `<${tag} path="${escapeAttribute(path)}" name="${escapeAttribute(name)}" />`;
}

export function mimeFromFilePath(filePath, fallback) {
  const ext = String(filePath ?? "").split(".").pop()?.toLowerCase();
  return (ext && MIME_FROM_EXT[ext]) || fallback;
}

export function largestPhoto(photos) {
  if (!Array.isArray(photos) || !photos.length) return null;
  return photos.reduce((best, cur) => {
    const b = best.file_size ?? (best.width ?? 0) * (best.height ?? 0);
    const c = cur.file_size ?? (cur.width ?? 0) * (cur.height ?? 0);
    return c >= b ? cur : best;
  });
}

export function forwardPrefix(msg) {
  const origin = msg?.forward_origin;
  if (origin) {
    if (origin.type === "user") {
      const u = origin.sender_user;
      const who = u?.username ? `@${u.username}` : (u?.first_name ?? "user");
      return `轉發自 ${who}`;
    }
    if (origin.type === "hidden_user") return `轉發自 ${origin.sender_user_name ?? "hidden user"}`;
    if (origin.type === "chat" || origin.type === "channel") {
      const title = origin.chat?.title ?? origin.author_signature ?? origin.type;
      return `轉發自 ${title}`;
    }
  }
  if (msg?.forward_from) {
    const u = msg.forward_from;
    return `轉發自 ${u.username ? `@${u.username}` : u.first_name}`;
  }
  if (msg?.forward_from_chat) return `轉發自 ${msg.forward_from_chat.title ?? "chat"}`;
  if (msg?.forward_sender_name) return `轉發自 ${msg.forward_sender_name}`;
  return "";
}

const DOCUMENT_MIME_BY_EXT = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const DOCUMENT_MIMES = new Set(Object.values(DOCUMENT_MIME_BY_EXT));
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const AUDIO_MIME_BY_EXT = {
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  webm: "audio/webm",
};

function fileExt(name) {
  return String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
}

function bareMime(value) {
  return String(value ?? "").split(";")[0].trim().toLowerCase();
}

/** Voice longer than this is transcribed here. This long or shorter goes to the cloud model. */
export const LOCAL_WHISPER_AFTER_SECONDS = 15;

export function transcribeLocally(durationSeconds) {
  return typeof durationSeconds === "number"
    && Number.isFinite(durationSeconds)
    && durationSeconds > LOCAL_WHISPER_AFTER_SECONDS;
}

/** One Telegram document, classified the way OpenMaus will store it. */
export function classifyDocument(doc) {
  if (!doc?.file_id) return null;
  const name = doc.file_name || "file";
  const ext = fileExt(name);
  const mime = bareMime(doc.mime_type);
  const imageMime = IMAGE_MIMES.has(mime) ? mime : (IMAGE_EXT.has(ext) ? (ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`) : "");
  if (imageMime) {
    return { kind: "image", fileId: doc.file_id, suggestedName: name, mime: imageMime, label: "（圖片）", fileSize: doc.file_size };
  }
  const audioMime = AUDIO_MIMES.has(mime) ? mime : (AUDIO_MIME_BY_EXT[ext] ?? "");
  if (audioMime) {
    return {
      kind: "file",
      fileId: doc.file_id,
      suggestedName: name,
      mime: audioMime,
      label: "（音訊）",
      fileSize: doc.file_size,
      transcribe: transcribeLocally(doc.duration),
    };
  }
  const documentMime = DOCUMENT_MIMES.has(mime) ? mime : DOCUMENT_MIME_BY_EXT[ext];
  if (!documentMime) return null;
  return { kind: "file", fileId: doc.file_id, suggestedName: name, mime: documentMime, label: "（檔案）", fileSize: doc.file_size };
}

export function mediaPlan(msg) {
  const items = [];
  const photo = largestPhoto(msg?.photo);
  if (photo?.file_id) {
    items.push({
      kind: "image",
      fileId: photo.file_id,
      suggestedName: "photo.jpg",
      mime: "image/jpeg",
      label: "（圖片）",
    });
  }
  if (msg?.voice?.file_id) {
    items.push({
      kind: "file",
      fileId: msg.voice.file_id,
      suggestedName: "voice.ogg",
      mime: msg.voice.mime_type || "audio/ogg",
      label: "（語音）",
      transcribe: transcribeLocally(msg.voice.duration),
    });
  }
  if (msg?.audio?.file_id) {
    items.push({
      kind: "file",
      fileId: msg.audio.file_id,
      suggestedName: msg.audio.file_name || "audio.mp3",
      mime: msg.audio.mime_type || "audio/mpeg",
      label: "（音訊）",
      transcribe: transcribeLocally(msg.audio.duration),
    });
  }
  const doc = classifyDocument(msg?.document);
  if (doc && !photo && !(doc.kind === "file" && doc.label === "（音訊）" && (msg?.voice || msg?.audio))) {
    if (!(doc.kind === "image" && photo)) items.push(doc);
  }
  return items;
}

export function unsupportedMediaReason(msg) {
  if (mediaPlan(msg).length) return null;
  if (msg?.video || msg?.video_note || msg?.animation) return "目前只會轉送文字、圖片、語音和文件（含轉發）。影片還沒接。";
  if (msg?.sticker) return "目前只會轉送文字、圖片、語音和文件（含轉發）。貼圖還沒接。";
  if (msg?.document) return "這個檔案格式還不能送進 OpenMaus。可以傳 PDF、Office、純文字、CSV、JSON，或圖片與音訊。";
  return null;
}

/** Text the model reads. The audio file stays on this machine. */
export function formatVoiceTranscript(name, transcript) {
  const shown = String(transcript ?? "").trim() || "（沒有辨識到內容）";
  return `（語音轉譯）${name}\n${shown}`;
}

export function composeIncoming({ prefix, replyNote: quoted, location, exif, caption, tags, fallback, transcripts }) {
  const lines = [];
  if (prefix) lines.push(prefix);
  if (quoted) lines.push(quoted);
  if (location) lines.push(location);
  const spoken = transcripts ?? [];
  const body = String(caption ?? "").trim() || (!location && !exif && spoken.length === 0 ? (fallback || "（附件）") : "");
  if (body) lines.push(body);
  if (exif) lines.push(exif);
  for (const block of spoken) {
    if (lines.length) lines.push("");
    lines.push(block);
  }
  for (const tag of tags ?? []) {
    lines.push("");
    lines.push(tag);
  }
  return lines.join("\n");
}

export function chunkBy(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
