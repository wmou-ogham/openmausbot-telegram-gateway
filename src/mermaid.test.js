import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderOutgoingMarkdown } from "./format.js";
import { createMermaidRenderer, defaultMermaidBin, embedMermaid } from "./mermaid.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("a finished mermaid fence becomes an image between the surrounding text", async () => {
  const src = "前文\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n後文";
  const text = await embedMermaid(src, async () => "/data/telegram-mermaid/abc.png");
  const shown = renderOutgoingMarkdown(text, (path) => (
    path.endsWith("/abc.png") ? "https://img.example/bed/abc.png" : null
  ));
  assert.equal(shown, "前文\n\n![圖表](https://img.example/bed/abc.png)\n\n後文");
});

test("an unfinished fence stays source so a stream can keep editing it", async () => {
  const src = "前文\n```mermaid\ngraph TD\n  A-->B";
  let called = false;
  const out = await embedMermaid(src, async () => {
    called = true;
    return "/data/diagram.png";
  });
  assert.equal(called, false);
  assert.equal(out, src);
});

test("mermaid mentioned inside another fence is not rendered", async () => {
  const src = ["```js", "```mermaid", "graph TD", "```", "after"].join("\n");
  let called = false;
  const out = await embedMermaid(src, async () => {
    called = true;
    return "/data/diagram.png";
  });
  assert.equal(called, false);
  assert.equal(out, src);
});

test("a tilde fence and an indented fence are replaced, and the diagram is dedented", async () => {
  const src = ["- 步驟", "  ~~~mermaid", "  graph TD", "    A-->B", "  ~~~"].join("\n");
  const seen = [];
  const out = await embedMermaid(src, async (source) => {
    seen.push(source);
    return "/data/diagram.png";
  });
  assert.deepEqual(seen, ["graph TD\n  A-->B"]);
  assert.equal(out, "- 步驟\n  ![圖表](/data/diagram.png)");
});

test("two diagrams stay in their own places", async () => {
  const src = ["上", "```mermaid", "graph TD", "  A-->B", "```", "中", "~~~mermaid", "sequenceDiagram", "  A->>B: hi", "~~~", "下"].join("\n");
  let n = 0;
  const out = await embedMermaid(src, async () => `/data/diagram-${n += 1}.png`);
  assert.equal(out, ["上", "![圖表](/data/diagram-1.png)", "中", "![圖表](/data/diagram-2.png)", "下"].join("\n"));
});

test("a failed or unsafe render leaves the original fence", async () => {
  const src = "```mermaid\ngraph TD\n  A-->B\n```";
  const failed = await embedMermaid(src, async () => {
    throw new Error("nope");
  });
  const unsafe = await embedMermaid(src, async () => "/tmp/bad path.png");
  assert.equal(failed, src);
  assert.equal(unsafe, src);
});

async function fakeRenderer(dir) {
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const script = join(dir, "mmdc");
  const count = join(dir, "count");
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
let input, output;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-i") input = args[++i];
  else if (args[i] === "-o") output = args[++i];
}
const src = readFileSync(input, "utf8");
appendFileSync(${JSON.stringify(count)}, "1");
if (src.includes("SLEEP")) await new Promise((resolve) => setTimeout(resolve, 5000));
if (src.includes("FAIL")) {
  process.stderr.write("parse failed\\n");
  process.exit(1);
}
writeFileSync(output, Buffer.from(${JSON.stringify(PNG.toString("base64"))}, "base64"));
`);
  await chmod(script, 0o755);
  return { script, count };
}

test("the renderer caches a png and does not retry a failed diagram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omb-mmdc-"));
  const cache = join(dir, "cache");
  const { script, count } = await fakeRenderer(dir);
  const errors = [];
  const render = createMermaidRenderer({
    bin: script,
    cacheDir: cache,
    onError: (error) => errors.push(error.message),
  });
  const first = await render("graph TD\n  A-->B");
  const second = await render("graph TD\n  A-->B");
  assert.equal(first, second);
  assert.equal(Buffer.compare(await readFile(first), PNG), 0);
  assert.equal(await readFile(count, "utf8"), "1");
  assert.equal(await render("FAIL"), null);
  assert.match(errors[0], /parse failed/);
  assert.equal(await render("FAIL"), null);
  assert.equal(errors.length, 1);
  assert.equal(await readFile(count, "utf8"), "11");
});

test("a missing renderer is reported once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omb-mmdc-miss-"));
  const errors = [];
  const render = createMermaidRenderer({
    bin: join(dir, "missing"),
    cacheDir: join(dir, "cache"),
    onError: (error) => errors.push(error.message),
  });
  assert.equal(await render("graph TD\n  A-->B"), null);
  assert.equal(await render("sequenceDiagram\n  A->>B: hi"), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing/);
});

test("a stuck renderer is killed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omb-mmdc-hang-"));
  const { script } = await fakeRenderer(dir);
  const errors = [];
  const render = createMermaidRenderer({
    bin: script,
    cacheDir: join(dir, "cache"),
    timeoutMs: 300,
    onError: (error) => errors.push(error.message),
  });
  const started = Date.now();
  assert.equal(await render("SLEEP"), null);
  assert.ok(Date.now() - started < 3000);
  assert.match(errors[0], /timed out/);
});

test("the installed mmdc renders a diagram into the original position", async () => {
  const bin = defaultMermaidBin(process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot"));
  try {
    await access(bin);
  } catch {
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "omb-mmdc-real-"));
  const errors = [];
  const render = createMermaidRenderer({
    bin,
    cacheDir: join(dir, "cache"),
    configPath: join(ROOT, "mermaid", "config.json"),
    puppeteerConfigPath: join(ROOT, "mermaid", "puppeteer.json"),
    onError: (error) => errors.push(error),
  });
  const src = "前文\n\n```mermaid\ngraph TD\n  A[開始] --> B[結束]\n```\n\n後文";
  const text = await embedMermaid(src, render);
  assert.equal(errors.length, 0);
  const match = /!\[圖表\]\(([^)]+)\)/.exec(text);
  assert.ok(match);
  const bytes = await readFile(match[1]);
  assert.equal(bytes.subarray(0, 8).equals(PNG.subarray(0, 8)), true);
  assert.match(text, /^前文\n\n!\[圖表\]\(\/.*\.png\)\n\n後文$/);
  const again = await embedMermaid(src, render);
  assert.equal(again, text);
});
