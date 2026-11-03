/** Reply linkage between a Telegram message_id and an OpenMaus message id. */

const LIMIT = 400;

export function replySource(message) {
  const replied = message?.reply_to_message;
  const quote = String(message?.quote?.text ?? "").trim();
  if (!replied && !quote) return null;
  const full = String(replied?.text ?? replied?.caption ?? "").trim();
  return {
    tgId: replied?.message_id,
    quote,
    full,
    described: full || describeReplied(replied),
  };
}

function describeReplied(message) {
  if (!message) return "";
  if (message.location || message.venue) return "一則位置訊息";
  if (message.photo) return "一張圖片";
  if (message.voice || message.audio) return "一段語音";
  if (message.document) return `檔案 ${message.document.file_name ?? ""}`.trim();
  return "";
}

/** When OpenMaus already has the target, promptWithReply quotes the stored
 * message. A partial selection still needs to be written out. Without a
 * stored id, the excerpt itself is the only context the model will see. */
export function replyNote(source, linked) {
  if (!source) return "";
  const quote = source.quote;
  const full = source.described;
  if (linked && quote && quote !== full) return `[回覆摘錄]\n${quote.slice(0, 900)}`;
  if (linked) return "";
  const excerpt = (quote || full).slice(0, 900);
  return excerpt ? `[回覆]\n${excerpt}` : "";
}

export function rememberLink(links, tgId, omId, preview) {
  const next = (Array.isArray(links) ? links : []).filter((link) => link.tg !== tgId && link.om !== omId);
  next.push({ tg: tgId, om: omId, preview: String(preview ?? "").slice(0, 180) });
  return next.slice(-LIMIT);
}

export function lookupLink(links, tgId) {
  if (tgId === undefined || tgId === null) return undefined;
  return (Array.isArray(links) ? links : []).find((link) => link.tg === tgId)?.om;
}

export function linkByText(links, text) {
  const wanted = String(text ?? "").trim();
  if (!wanted) return undefined;
  return [...(Array.isArray(links) ? links : [])].reverse().find((link) => link.preview.trim() === wanted.slice(0, 180).trim());
}
