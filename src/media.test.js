import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentTag,
  composeIncoming,
  formatVoiceTranscript,
  forwardPrefix,
  transcribeLocally,
  largestPhoto,
  mediaPlan,
  unsupportedMediaReason,
} from "./media.js";

test("largestPhoto picks the biggest size", () => {
  const big = largestPhoto([
    { file_id: "a", width: 90, height: 90, file_size: 100 },
    { file_id: "b", width: 1280, height: 720, file_size: 80000 },
  ]);
  assert.equal(big.file_id, "b");
});

test("mediaPlan maps photo and voice, including forwards", () => {
  const photo = mediaPlan({ photo: [{ file_id: "p", width: 100, height: 100 }] });
  assert.equal(photo[0].kind, "image");
  const voice = mediaPlan({ voice: { file_id: "v", mime_type: "audio/ogg", duration: 4 } });
  assert.equal(voice[0].kind, "file");
  assert.equal(voice[0].suggestedName, "voice.ogg");
  assert.equal(voice[0].transcribe, false);
});

test("voice of 15 seconds or less goes to the cloud and longer audio is local whisper", () => {
  assert.equal(transcribeLocally(0), false);
  assert.equal(transcribeLocally(3), false);
  assert.equal(transcribeLocally(15), false);
  assert.equal(transcribeLocally(16), true);
  assert.equal(transcribeLocally(undefined), false);
  const shortVoice = mediaPlan({ voice: { file_id: "v", duration: 15 } });
  assert.equal(shortVoice[0].transcribe, false);
  const longVoice = mediaPlan({ voice: { file_id: "v", duration: 16 } });
  assert.equal(longVoice[0].transcribe, true);
  const longAudio = mediaPlan({ audio: { file_id: "a", file_name: "note.mp3", duration: 90 } });
  assert.equal(longAudio[0].transcribe, true);
});

test("forwardPrefix reads Bot API origin", () => {
  assert.equal(
    forwardPrefix({ forward_origin: { type: "user", sender_user: { username: "Alice" } } }),
    "轉發自 @Alice",
  );
  assert.equal(forwardPrefix({}), "");
});

test("composeIncoming puts caption then attachment tags", () => {
  const tag = attachmentTag("image", "/data/openmaus/attachments/x.jpg", "photo.jpg");
  const text = composeIncoming({ prefix: "轉發自 @Bob", caption: "看這張", tags: [tag] });
  assert.match(text, /^轉發自 @Bob\n看這張\n\n<attached-image /);
  assert.match(text, /path="\/data\/openmaus\/attachments\/x\.jpg"/);
});

test("a pdf document is a file OpenMaus can store", () => {
  const plan = mediaPlan({ document: { file_id: "d", file_name: "ticket.pdf", mime_type: "application/pdf", file_size: 100 } });
  assert.equal(plan[0].kind, "file");
  assert.equal(plan[0].mime, "application/pdf");
  assert.equal(plan[0].label, "（檔案）");
  assert.equal(plan[0].transcribe, undefined);
});

test("a voice transcript is text and not an attachment tag", () => {
  const text = composeIncoming({
    transcripts: [formatVoiceTranscript("voice.ogg", "明天提醒我付款")],
  });
  assert.match(text, /（語音轉譯）voice\.ogg/);
  assert.match(text, /明天提醒我付款/);
  assert.equal(text.includes("<attached-file"), false);
});

test("an unknown archive is explained instead of dropped quietly", () => {
  assert.match(unsupportedMediaReason({ document: { file_id: "z", file_name: "x.zip", mime_type: "application/zip" } }), /檔案格式/);
});

test("unsupported video is explained", () => {
  assert.match(unsupportedMediaReason({ video: { file_id: "x" } }), /影片/);
  assert.equal(unsupportedMediaReason({ text: "hi" }), null);
});
