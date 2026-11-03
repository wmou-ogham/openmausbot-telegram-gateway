/** GPS from a JPEG APP1 Exif block. Telegram's compressed photos usually have
 * none; a picture sent as a file often still has it. */

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
}

function tiffFromJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const size = buf.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buf.length) break;
    if (marker === 0xe1) {
      const start = offset + 4;
      if (buf.toString("ascii", start, start + 6) === "Exif\0\0") {
        return buf.subarray(start + 6, offset + 2 + size);
      }
    }
    offset += 2 + size;
  }
  return null;
}

export function gpsFromJpeg(bytes) {
  const tiff = tiffFromJpeg(asBuffer(bytes));
  return tiff ? gpsFromTiff(tiff) : null;
}

/** Capture time as stored in the JPEG, `YYYY:MM:DD HH:MM:SS`, or null. */
export function capturedAtFromJpeg(bytes) {
  const tiff = tiffFromJpeg(asBuffer(bytes));
  if (!tiff || tiff.length < 8) return null;
  const endian = tiff.toString("ascii", 0, 2);
  const le = endian === "II";
  if (!le && endian !== "MM") return null;
  const u16 = (at) => (at + 2 <= tiff.length ? (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)) : null);
  const u32 = (at) => (at + 4 <= tiff.length ? (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)) : null);
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 === null) return null;
  const direct = inlineAscii(tiff, field(tiff, u16, u32, ifd0, 0x0132));
  if (direct) return direct;
  const exifAt = pointer(tiff, u16, u32, ifd0, 0x8769);
  if (exifAt === null) return null;
  return inlineAscii(tiff, field(tiff, u16, u32, exifAt, 0x9003)) || null;
}

function gpsFromTiff(tiff) {
  if (tiff.length < 8) return null;
  const endian = tiff.toString("ascii", 0, 2);
  const le = endian === "II";
  if (!le && endian !== "MM") return null;
  const u16 = (at) => (at + 2 <= tiff.length ? (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)) : null);
  const u32 = (at) => (at + 4 <= tiff.length ? (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)) : null);
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 === null) return null;
  const gpsAt = pointer(tiff, u16, u32, ifd0, 0x8825);
  if (gpsAt === null) return null;
  const lat = rationals(tiff, u32, field(tiff, u16, u32, gpsAt, 0x0002));
  const lon = rationals(tiff, u32, field(tiff, u16, u32, gpsAt, 0x0004));
  const latitude = coordinate(lat, inlineAscii(tiff, field(tiff, u16, u32, gpsAt, 0x0001)));
  const longitude = coordinate(lon, inlineAscii(tiff, field(tiff, u16, u32, gpsAt, 0x0003)));
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function field(tiff, u16, u32, ifd, tag) {
  const count = u16(ifd);
  if (count === null) return null;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) !== tag) continue;
    return { entry, type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8) };
  }
  return null;
}

function pointer(tiff, u16, u32, ifd, tag) {
  const found = field(tiff, u16, u32, ifd, tag);
  return found?.value ?? null;
}

function inlineAscii(tiff, found) {
  if (!found || found.type !== 2 || !found.count) return "";
  if (found.count <= 4) return tiff.toString("ascii", found.entry + 8, found.entry + 8 + found.count).replace(/\0.*/, "");
  if (found.value + found.count > tiff.length) return "";
  return tiff.toString("ascii", found.value, found.value + found.count).replace(/\0.*/, "");
}

function rationals(tiff, u32, found) {
  if (!found || found.type !== 5 || found.count < 3 || found.value === null) return null;
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const num = u32(found.value + i * 8);
    const den = u32(found.value + i * 8 + 4);
    if (num === null || !den) return null;
    parts.push(num / den);
  }
  return parts;
}

function coordinate(parts, ref) {
  if (!parts) return null;
  const value = parts[0] + parts[1] / 60 + parts[2] / 3600;
  if (!Number.isFinite(value)) return null;
  return ref === "S" || ref === "W" ? -value : value;
}
