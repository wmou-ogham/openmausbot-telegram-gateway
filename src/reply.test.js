import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupLink, rememberLink, replyNote, replySource } from "./reply.js";

test("a reply without a stored id keeps the quoted text", () => {
  const source = replySource({
    reply_to_message: { message_id: 4, text: "原本的行程" },
  });
  assert.equal(replyNote(source, false), "[回覆]\n原本的行程");
  assert.equal(replyNote(source, true), "");
});

test("a partial selection is kept even when the message is linked", () => {
  const source = replySource({
    quote: { text: "餐廳" },
    reply_to_message: { message_id: 4, text: "早上先去餐廳，下午再去美術館，晚上回旅館" },
  });
  assert.match(replyNote(source, true), /回覆摘錄/);
  assert.match(replyNote(source, true), /餐廳/);
});

test("links are capped and looked up by telegram id", () => {
  let links = [];
  for (let i = 0; i < 450; i++) links = rememberLink(links, i, `om-${i}`, "x");
  assert.equal(links.length, 400);
  assert.equal(lookupLink(links, 0), undefined);
  assert.equal(lookupLink(links, 449), "om-449");
});
