import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProgressiveJpeg, publishLocalImage } from "./image-bed.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("publishLocalImage copies a hashed file and returns an https URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "omb-bed-"));
  const publish = join(root, "www");
  await writeFile(join(root, "ok.png"), PNG);
  const published = await publishLocalImage(join(root, "ok.png"), {
    dataDir: root,
    publishDir: publish,
    publicBase: "https://img.example/bed/",
  });
  assert.match(published.url, /^https:\/\/img\.example\/bed\/[0-9a-f]{32}\.png$/);
  assert.equal(Buffer.compare(await readFile(published.path), PNG), 0);
  const again = await publishLocalImage(join(root, "ok.png"), {
    dataDir: root,
    publishDir: publish,
    publicBase: "https://img.example/bed",
  });
  assert.equal(again.url, published.url);
});

test("publishLocalImage stores a progressive JPEG as baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "omb-bed-jpg-"));
  const progressive = await new Promise((resolve, reject) => {
    const child = spawnPillow();
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`pillow ${code}`))));
    child.stdin.end();
  });
  assert.equal(isProgressiveJpeg(progressive), true);
  await writeFile(join(root, "prog.jpg"), progressive);
  const published = await publishLocalImage(join(root, "prog.jpg"), {
    dataDir: root,
    publishDir: join(root, "www"),
    publicBase: "https://img.example/bed",
  });
  const stored = await readFile(published.path);
  assert.equal(isProgressiveJpeg(stored), false);
  assert.match(published.url, /\.jpg$/);
});

function spawnPillow() {
  return spawn("python3", ["-c", [
    "from io import BytesIO",
    "from PIL import Image",
    "im = Image.new('RGB', (8, 8), 'red')",
    "out = BytesIO()",
    "im.save(out, format='JPEG', quality=80, progressive=True)",
    "import sys",
    "sys.stdout.buffer.write(out.getvalue())",
  ].join("\n")]);
}

test("publishLocalImage refuses a file outside the data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omb-bed-"));
  const outside = await mkdtemp(join(tmpdir(), "omb-outside-"));
  await writeFile(join(outside, "no.png"), PNG);
  await assert.rejects(
    () => publishLocalImage(join(outside, "no.png"), {
      dataDir: root,
      publishDir: join(root, "www"),
      publicBase: "https://img.example/bed",
    }),
    /outside data dir/,
  );
});
