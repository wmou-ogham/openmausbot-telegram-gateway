import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContexts, readContext, updateContext } from "./context.js";

test("context keeps the latest location and a photo without dropping the other", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-context-"));
  updateContext(dir, "bot-a", {
    botName: "Moriss",
    location: { latitude: 25, longitude: 121, active: true, updatedAt: 10 },
  });
  const saved = updateContext(dir, "bot-a", {
    photo: { at: 20, name: "a.jpg", path: "/data/attachments/a.jpg", latitude: 25.1, longitude: 121.1 },
  });
  assert.equal(saved.location.latitude, 25);
  assert.equal(saved.photos.length, 1);
  assert.equal(readContext(dir, "bot-a").botName, "Moriss");
  assert.equal(listContexts(dir).length, 1);
});
