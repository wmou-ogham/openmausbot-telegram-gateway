import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { updateContext } from "./context.js";
import { encodeFrame, handleRpc, takeFrame } from "./telegram-mcp.js";

function u16(n) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}
function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

function sampleJpeg() {
  const latRats = Buffer.concat([u32(25), u32(1), u32(0), u32(1), u32(0), u32(1)]);
  const lonRats = Buffer.concat([u32(121), u32(1), u32(30), u32(1), u32(0), u32(1)]);
  const gpsAt = 26;
  const latAt = 80;
  const lonAt = 104;
  const ifd0 = Buffer.concat([u16(1), u16(0x8825), u16(4), u32(1), u32(gpsAt), u32(0)]);
  const ref = (tag, letter) => Buffer.concat([
    u16(tag), u16(2), u32(2), Buffer.from([letter.charCodeAt(0), 0, 0, 0]),
  ]);
  const rats = (tag, at) => Buffer.concat([u16(tag), u16(5), u32(3), u32(at)]);
  const gps = Buffer.concat([
    u16(4), ref(1, "N"), rats(2, latAt), ref(3, "E"), rats(4, lonAt), u32(0),
  ]);
  const tiff = Buffer.concat([Buffer.from("II"), u16(42), u32(8), ifd0, gps, latRats, lonRats]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, Buffer.from([0xff, 0xd9])]);
}

test("get_location stays empty until a fix is stored, then returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-mcp-"));
  updateContext(dir, "bot-a", { botName: "Moriss" });
  const empty = handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_location", arguments: {} } }, dir);
  assert.match(empty.result.content[0].text, /沒有記下位置/);
  updateContext(dir, "bot-a", { location: { latitude: 25.033, longitude: 121.565, active: true, updatedAt: 1_700_000_000_000 } });
  const found = handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_location", arguments: {} } }, dir);
  assert.match(found.result.content[0].text, /25\.03300/);
  assert.match(found.result.content[0].text, /分享中/);
});

test("several bots do not leak coordinates until botId is chosen", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-mcp-"));
  updateContext(dir, "bot-a", { botName: "Moriss", location: { latitude: 25, longitude: 121, active: true } });
  updateContext(dir, "bot-b", { botName: "Seeker", location: { latitude: 1, longitude: 2 } });
  const ambiguous = handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_location", arguments: {} } }, dir);
  assert.equal(ambiguous.result.isError, true);
  assert.doesNotMatch(ambiguous.result.content[0].text, /25/);
  const chosen = handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_location", arguments: { botId: "bot-b" } } }, dir);
  assert.match(chosen.result.content[0].text, /1\.00000/);
});

test("read_photo_exif reads an owned jpeg and refuses a symlink escape", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-mcp-"));
  const attachments = join(root, "attachments");
  const outside = join(root, "secret.jpg");
  mkdirSync(attachments);
  writeFileSync(join(attachments, "shot.jpg"), sampleJpeg());
  writeFileSync(outside, sampleJpeg());
  symlinkSync(outside, join(attachments, "link.jpg"));
  const context = join(root, "telegram-context");
  const ok = handleRpc({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "read_photo_exif", arguments: { path: join(attachments, "shot.jpg") } },
  }, context, attachments);
  assert.match(ok.result.content[0].text, /25\.00000/);
  assert.match(ok.result.content[0].text, /121\.50000/);
  const escaped = handleRpc({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "read_photo_exif", arguments: { path: join(attachments, "link.jpg") } },
  }, context, attachments);
  assert.equal(escaped.result.isError, true);
});

test("newline and content-length frames both round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-mcp-"));
  updateContext(dir, "bot-a", { location: { latitude: 25, longitude: 121, active: false } });
  const child = spawn(process.execPath, [new URL("./telegram-mcp.js", import.meta.url).pathname], {
    env: { ...process.env, TELEGRAM_CONTEXT_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = Buffer.alloc(0);
  const frames = [];
  child.stdout.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const frame = takeFrame(pending);
      if (!frame) break;
      pending = frame.rest;
      frames.push(frame.message);
    }
  });
  const send = (message, framing) => child.stdin.write(encodeFrame(message, framing));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, "line");
  send({ jsonrpc: "2.0", method: "notifications/initialized" }, "line");
  send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "get_location", arguments: {} },
  }, "lsp");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mcp did not answer")), 3000);
    const wait = () => {
      if (frames.length >= 2) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(wait, 20);
    };
    wait();
  });
  child.kill();
  assert.equal(frames[0].result.serverInfo.name, "telegram");
  assert.match(frames[1].result.content[0].text, /25\.00000/);
});
