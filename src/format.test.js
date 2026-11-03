import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  demoteImages,
  formatAlignedTable,
  markdownToTelegramHtml,
  renderOutgoingMarkdown,
  resolveLocalPhoto,
  splitOutgoingImages,
  stabilizeMarkdown,
} from "./format.js";

test("**bold** and ### headings become HTML in fallback", () => {
  const html = markdownToTelegramHtml("### Title\n\nHello **world**.");
  assert.match(html, /<b>Title<\/b>/);
  assert.match(html, /<b>world<\/b>/);
});

test("GFM table becomes aligned <pre> in HTML fallback", () => {
  const md = [
    "| 項目 | 內容 |",
    "|------|------|",
    "| 時間 | 每天 **08:00** |",
  ].join("\n");
  const html = markdownToTelegramHtml(md);
  assert.match(html, /^<pre>/);
  assert.match(html, /項目/);
  assert.doesNotMatch(html, /\|------\|/);
});

test("formatAlignedTable pads CJK columns", () => {
  const table = formatAlignedTable([
    "| 項目 | 內容 |",
    "|---|---|",
    "| 名稱 | SiFive |",
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /項目/);
});

test("stabilizeMarkdown closes unfinished bold and fences", () => {
  assert.equal(stabilizeMarkdown("hello **there").endsWith("**"), true);
  assert.match(stabilizeMarkdown("```js\nconst x = 1"), /```$/);
});

test("a published local image is rewritten to its public URL", () => {
  const src = "前文\n![原子湖](/data/lake.jpg)\n後文";
  const text = renderOutgoingMarkdown(src, (path) => (
    path === "/data/lake.jpg" ? "https://img.example/bed/abc.jpg" : null
  ));
  assert.match(text, /前文/);
  assert.match(text, /後文/);
  assert.match(text, /!\[[^\]]*原子湖[^\]]*\]\(https:\/\/img\.example\/bed\/abc\.jpg\)/);
  assert.doesNotMatch(text, /\/data\/lake\.jpg/);
});

test("local images leave the rich text and stay available to upload", () => {
  const src = [
    "前文",
    "",
    "![原子湖](/data/openmaus/polygon_atomic_lake.jpg)",
    "",
    "後文 [官方](https://example.com/tour)",
    "![遠端](https://example.com/photo.jpg)",
  ].join("\n");
  const split = splitOutgoingImages(src);
  assert.match(split.text, /前文/);
  assert.match(split.text, /後文/);
  assert.match(split.text, /https:\/\/example\.com\/photo\.jpg/);
  assert.doesNotMatch(split.text, /polygon_atomic_lake/);
  assert.deepEqual(split.images, [
    { alt: "原子湖", path: "/data/openmaus/polygon_atomic_lake.jpg" },
  ]);
});

test("file URLs are local photos and fenced paths are left alone", () => {
  const src = [
    "![標誌](file:///data/openmaus/sign.jpg)",
    "```",
    "![not a photo](/tmp/secret.jpg)",
    "```",
    "結尾 ![半成品](/data/openmaus/partial",
  ].join("\n");
  const split = splitOutgoingImages(src);
  assert.deepEqual(split.images, [
    { alt: "標誌", path: "/data/openmaus/sign.jpg" },
  ]);
  assert.match(split.text, /\/tmp\/secret\.jpg/);
  assert.doesNotMatch(split.text, /partial/);
});

test("a rejected embedded image becomes a link instead of a photo", () => {
  const text = demoteImages("看 ![現場](https://cdn.example/a.jpg) 就好");
  assert.equal(text, "看 [現場](https://cdn.example/a.jpg) 就好");
  assert.doesNotMatch(text, /!\[/);
});

test("resolveLocalPhoto stays inside the data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omb-photo-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(root, "ok.png"), png);
  const resolved = await resolveLocalPhoto(join(root, "ok.png"), root);
  assert.equal(resolved.mime, "image/png");
  await symlink("/etc/hosts", join(root, "escape.png"));
  await assert.rejects(() => resolveLocalPhoto(join(root, "escape.png"), root), /outside data dir/);
  await assert.rejects(() => resolveLocalPhoto(join(root, "missing.png"), root), /missing/);
});
