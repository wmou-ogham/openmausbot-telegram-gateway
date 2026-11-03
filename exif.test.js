import { test } from "node:test";
import assert from "node:assert/strict";
import { gpsFromJpeg } from "./exif.js";

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

function sample(latRef = "N", lonRef = "E") {
  const latRats = Buffer.concat([u32(25), u32(1), u32(2), u32(1), u32(0), u32(1)]);
  const lonRats = Buffer.concat([u32(121), u32(1), u32(30), u32(1), u32(0), u32(1)]);
  const gpsAt = 26;
  const latAt = 80;
  const lonAt = 104;
  const ifd0 = Buffer.concat([
    u16(1),
    u16(0x8825), u16(4), u32(1), u32(gpsAt),
    u32(0),
  ]);
  const ref = (tag, letter) => Buffer.concat([
    u16(tag), u16(2), u32(2), Buffer.from([letter.charCodeAt(0), 0, 0, 0]),
  ]);
  const rats = (tag, at) => Buffer.concat([u16(tag), u16(5), u32(3), u32(at)]);
  const gps = Buffer.concat([
    u16(4),
    ref(1, latRef),
    rats(2, latAt),
    ref(3, lonRef),
    rats(4, lonAt),
    u32(0),
  ]);
  const tiff = Buffer.concat([
    Buffer.from("II"),
    u16(42),
    u32(8),
    ifd0,
    gps,
    latRats,
    lonRats,
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, Buffer.from([0xff, 0xd9])]);
}

test("reads GPS degrees from a JPEG Exif block", () => {
  const gps = gpsFromJpeg(sample());
  assert.ok(Math.abs(gps.latitude - (25 + 2 / 60)) < 1e-6);
  assert.ok(Math.abs(gps.longitude - (121 + 30 / 60)) < 1e-6);
});

test("south and west references are negative", () => {
  const gps = gpsFromJpeg(sample("S", "W"));
  assert.ok(gps.latitude < 0);
  assert.ok(gps.longitude < 0);
});

test("a JPEG without Exif has no GPS", () => {
  assert.equal(gpsFromJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});
