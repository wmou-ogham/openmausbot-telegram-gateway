import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOutbound } from "./outbound.js";

test("location tags and file tags leave the visible reply", () => {
  const taken = collectOutbound([
    "檔案在這",
    '<telegram-location latitude="25" longitude="121" title="車站" address="台北" />',
    '<attached-file path="/data/openmaus/attachments/a.pdf" name="a.pdf" />',
  ].join("\n"));
  assert.equal(taken.text, "檔案在這");
  assert.equal(taken.locations[0].title, "車站");
  assert.equal(taken.files[0].name, "a.pdf");
});

test("a markdown image is not treated as a document", () => {
  const taken = collectOutbound("看 ![圖](/tmp/a.jpg)");
  assert.equal(taken.files.length, 0);
  assert.match(taken.text, /!\[圖\]/);
});

test("a markdown link to a local pdf is a file", () => {
  const taken = collectOutbound("看 [票](/data/trip/ticket.pdf)");
  assert.equal(taken.files[0].path, "/data/trip/ticket.pdf");
  assert.equal(taken.text, "看 票");
});

test("a markdown link to a directory stays text and is not a document", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-out-"));
  const dir = join(root, "insta360-stitcher");
  mkdirSync(dir);
  const taken = collectOutbound(`路徑：[\`${dir}/\`](file://${dir}/)。`);
  assert.equal(taken.files.length, 0);
  assert.match(taken.text, new RegExp(dir.replaceAll("/", "\\/")));
  assert.doesNotMatch(taken.text, /file:/);
});

test("a markdown link to a real file is still a document", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-out-"));
  const file = join(root, "ticket.pdf");
  writeFileSync(file, "%PDF");
  const taken = collectOutbound(`看 [票](${file})`);
  assert.equal(taken.files[0].path, file);
  assert.equal(taken.text, "看 票");
});

test("an attached-file tag still queues a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-out-"));
  const dir = join(root, "proj");
  mkdirSync(dir);
  const taken = collectOutbound(`<attached-file path="${dir}" name="proj" />`);
  assert.equal(taken.files[0].path, dir);
  assert.equal(taken.text, "");
});
