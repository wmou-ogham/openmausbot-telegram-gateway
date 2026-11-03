import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriber } from "./stt.js";

test("a missing whisper install is reported before spawn", async () => {
  const stt = createTranscriber({
    pythonPath: join(tmpdir(), "no-such-stt-python"),
    scriptPath: join(tmpdir(), "no-such-worker.py"),
  });
  await assert.rejects(stt.transcribe("/tmp/voice.ogg"), /stt\/setup\.sh/);
});

test("the worker protocol returns the transcript for one file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-stt-test-"));
  const script = join(dir, "fake.py");
  await writeFile(script, `
import json, sys
sys.stdout.write(json.dumps({"ready": True}) + "\\n")
sys.stdout.flush()
for line in sys.stdin:
    job = json.loads(line)
    sys.stdout.write(json.dumps({"id": job["id"], "text": "明天付款"}) + "\\n")
    sys.stdout.flush()
`);
  const stt = createTranscriber({ pythonPath: "/usr/bin/python3", scriptPath: script, dataDir: dir });
  try {
    assert.equal(await stt.transcribe(join(dir, "voice.ogg")), "明天付款");
  } finally {
    stt.stop();
  }
});
