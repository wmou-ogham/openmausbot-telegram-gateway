#!/usr/bin/env node
/** stdio MCP server. OpenMaus mounts it as a normal custom MCP server.
 * Tools return Telegram location and photo GPS only when the model asks.
 * Speaks both newline JSON-RPC (OpenMaus) and Content-Length frames (Claude). */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { listContexts, readContext, defaultContextDir } from "./context.js";
import { capturedAtFromJpeg, gpsFromJpeg } from "./exif.js";

const PHOTO_BYTES = 15 * 1024 * 1024;

const TOOLS = [
  {
    name: "get_location",
    description: "讀這位 Telegram 使用者最近分享的位置或即時位置。只有回答依賴地點時才呼叫。座標不會出現在訊息正文裡。",
    inputSchema: {
      type: "object",
      properties: {
        botId: { type: "string", description: "OpenMaus bot id。只連一個 Telegram bot 時可省略。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_photo_locations",
    description: "最近幾張仍帶 GPS 的 Telegram 照片。沒有座標就會是空的。使用者提到某張照片的地點、而這則訊息沒有檔案路徑時使用。",
    inputSchema: {
      type: "object",
      properties: {
        botId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_photo_exif",
    description: "解析使用者傳來的 JPEG。傳入訊息裡的 attached-image 或 attached-file 路徑。沒有 GPS 就明說沒有，不要自己猜座標。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "附件的絕對路徑。" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function attachmentsDir(contextDir) {
  return process.env.TELEGRAM_ATTACHMENTS_DIR || join(dirname(contextDir), "attachments");
}

function pick(contextDir, botId) {
  if (botId !== undefined && botId !== null && typeof botId !== "string") {
    return { error: "botId 必須是字串。" };
  }
  const wanted = typeof botId === "string" ? botId.trim() : "";
  if (wanted) {
    const found = readContext(contextDir, wanted);
    if (!found) return { error: `沒有這個 bot 的 Telegram 脈絡：${wanted}` };
    return { context: found };
  }
  const all = listContexts(contextDir);
  if (all.length === 1) return { context: all[0] };
  if (all.length === 0) return { error: "還沒有 Telegram 脈絡。" };
  const lines = all.map((item) => `${item.botId}${item.botName ? `（${item.botName}）` : ""}`);
  return { error: `有多個 Telegram bot，請帶 botId。\n${lines.join("\n")}` };
}

function formatLocation(context) {
  const who = context.botName ? `${context.botName}（${context.botId}）` : context.botId;
  const loc = context.location;
  if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") {
    return `${who}\n沒有記下位置。`;
  }
  const lines = [who];
  if (loc.active) lines.push("狀態：即時位置分享中");
  else if (loc.stopped) lines.push("狀態：即時位置已停止，以下是最後一點");
  else lines.push("狀態：單一位置");
  if (loc.title) lines.push(`名稱：${loc.title}`);
  if (loc.address) lines.push(`地址：${loc.address}`);
  lines.push(`緯度：${Number(loc.latitude).toFixed(5)}`);
  lines.push(`經度：${Number(loc.longitude).toFixed(5)}`);
  if (typeof loc.horizontalAccuracy === "number") lines.push(`精度：約 ${Math.round(loc.horizontalAccuracy)} 公尺`);
  if (typeof loc.heading === "number") lines.push(`方向：${Math.round(loc.heading)}°`);
  if (loc.updatedAt) lines.push(`更新：${new Date(loc.updatedAt).toISOString()}`);
  return lines.join("\n");
}

function ownedJpeg(filePath, rootDir) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) return null;
  let root;
  try {
    root = realpathSync(rootDir);
  } catch {
    return null;
  }
  const resolved = resolve(filePath);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > PHOTO_BYTES) return null;
  let canonical;
  try {
    canonical = realpathSync(resolved);
  } catch {
    return null;
  }
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith("..")) return null;
  return canonical;
}

function callTool(name, args, contextDir, attachments) {
  if (name === "get_location") {
    const picked = pick(contextDir, args.botId);
    if (picked.error) return textResult(picked.error, true);
    return textResult(formatLocation(picked.context));
  }
  if (name === "list_photo_locations") {
    const picked = pick(contextDir, args.botId);
    if (picked.error) return textResult(picked.error, true);
    const limit = Number.isInteger(args.limit) ? Math.min(20, Math.max(1, args.limit)) : 5;
    const photos = (Array.isArray(picked.context.photos) ? picked.context.photos : []).slice(0, limit);
    if (!photos.length) return textResult("沒有帶 GPS 的照片。");
    const lines = photos.map((photo) => {
      const when = photo.at ? new Date(photo.at).toISOString() : "時間不明";
      return `${when} ${photo.name ?? "照片"} ${Number(photo.latitude).toFixed(5)}, ${Number(photo.longitude).toFixed(5)}\n${photo.path}`;
    });
    return textResult(lines.join("\n\n"));
  }
  if (name === "read_photo_exif") {
    const path = ownedJpeg(args.path, attachments || attachmentsDir(contextDir));
    if (!path) return textResult("只能讀取 OpenMaus 附件目錄裡、15MB 以內的檔案。", true);
    const bytes = readFileSync(path);
    const gps = gpsFromJpeg(bytes);
    const capturedAt = capturedAtFromJpeg(bytes);
    if (!gps && !capturedAt) return textResult("這張圖沒有可用的 EXIF GPS 或拍攝時間。Telegram 壓縮過的照片通常會拿掉 GPS。");
    const lines = [];
    if (gps) {
      lines.push(`緯度：${gps.latitude.toFixed(5)}`);
      lines.push(`經度：${gps.longitude.toFixed(5)}`);
    } else {
      lines.push("沒有 GPS。");
    }
    if (capturedAt) lines.push(`拍攝時間：${capturedAt}`);
    return textResult(lines.join("\n"));
  }
  return textResult(`沒有這個工具：${name}`, true);
}

function argumentsOf(params) {
  const raw = params?.arguments ?? {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

export function handleRpc(message, contextDir = defaultContextDir(), attachments) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return null;
  const id = message.id;
  const hasId = id !== undefined && id !== null;
  if (!hasId) return null;
  const fail = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (message.method === "initialize") {
    const version = typeof message.params?.protocolVersion === "string"
      ? message.params.protocolVersion
      : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "telegram", version: "1" },
        instructions: "Telegram 的位置與照片 GPS 要呼叫工具才拿得到，不要假設訊息裡有座標。一般閒聊不要呼叫。",
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = argumentsOf(message.params);
    if (typeof name !== "string" || !args) return fail(-32602, "Invalid tool call");
    return { jsonrpc: "2.0", id, result: callTool(name, args, contextDir, attachments) };
  }
  return fail(-32601, "Method not found");
}

export function takeFrame(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] === 10 || buffer[start] === 13)) start += 1;
  if (start >= buffer.length) return null;
  if (buffer[start] === 0x7b) {
    const nl = buffer.indexOf(0x0a, start);
    if (nl < 0) return null;
    const line = buffer.subarray(start, nl).toString("utf8").replace(/\r$/, "");
    return { message: JSON.parse(line), framing: "line", rest: buffer.subarray(nl + 1) };
  }
  const sep = buffer.indexOf("\r\n\r\n", start);
  if (sep < 0) return null;
  const header = buffer.subarray(start, sep).toString("utf8");
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) throw new Error("missing Content-Length");
  const len = Number(match[1]);
  const bodyAt = sep + 4;
  if (buffer.length < bodyAt + len) return null;
  const message = JSON.parse(buffer.subarray(bodyAt, bodyAt + len).toString("utf8"));
  return { message, framing: "lsp", rest: buffer.subarray(bodyAt + len) };
}

export function encodeFrame(message, framing) {
  const json = JSON.stringify(message);
  if (framing === "lsp") return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  return Buffer.from(`${json}\n`);
}

function serve() {
  const contextDir = defaultContextDir();
  let pending = Buffer.alloc(0);
  let framing = "line";
  process.stdin.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 1024 * 1024) {
      console.error("telegram mcp: frame too large");
      process.exit(1);
    }
    try {
      for (;;) {
        const frame = takeFrame(pending);
        if (!frame) break;
        pending = frame.rest;
        framing = frame.framing;
        const response = handleRpc(frame.message, contextDir);
        if (response) process.stdout.write(encodeFrame(response, framing));
      }
    } catch (error) {
      console.error(`telegram mcp: ${error instanceof Error ? error.message : error}`);
    }
  });
}

const invoked = process.argv[1] && /telegram-mcp\.js$/.test(process.argv[1]);
if (invoked) serve();
