import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveLocalPhoto } from "./format.js";

/** Telegram's rich-message viewer fails to paint a progressive JPEG and shows Image unavailable. */
export function isProgressiveJpeg(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) break;
    const marker = buf[i];
    i += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= buf.length) break;
    const len = (buf[i] << 8) | buf[i + 1];
    if (marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce) return true;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc3) return false;
    if (len < 2) break;
    i += len;
  }
  return false;
}

export async function baselineJpeg(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!isProgressiveJpeg(input)) return input;
  const script = [
    "import sys",
    "from io import BytesIO",
    "from PIL import Image",
    "im = Image.open(BytesIO(sys.stdin.buffer.read()))",
    "if im.mode not in ('RGB', 'L'):",
    "    im = im.convert('RGB')",
    "out = BytesIO()",
    "im.save(out, format='JPEG', quality=90, progressive=False, optimize=True)",
    "sys.stdout.buffer.write(out.getvalue())",
  ].join("\n");
  const output = await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", script]);
    const chunks = [];
    const errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(Buffer.concat(errors).toString() || `pillow exit ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
  if (!output.length || isProgressiveJpeg(output)) throw new Error("baseline jpeg conversion failed");
  return output;
}

/** Copy one data-dir image into the public bed. The name is a content hash, not the original path. */
export async function publishLocalImage(sourcePath, { dataDir, publishDir, publicBase }) {
  const photo = await resolveLocalPhoto(sourcePath, dataDir);
  let bytes = await readFile(photo.path);
  const ext = extname(photo.path).toLowerCase() === ".jpeg" ? ".jpg" : extname(photo.path).toLowerCase();
  if (ext === ".jpg") bytes = await baselineJpeg(bytes);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const name = `${digest}${ext}`;
  await mkdir(publishDir, { recursive: true, mode: 0o755 });
  const dest = join(publishDir, name);
  const tmp = join(publishDir, `.${name}.${process.pid}.tmp`);
  await writeFile(tmp, bytes, { mode: 0o644 });
  await rename(tmp, dest);
  await chmod(dest, 0o644);
  const base = String(publicBase ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) throw new Error("image bed requires an https public base");
  return { url: `${base}/${name}`, name, path: dest };
}
