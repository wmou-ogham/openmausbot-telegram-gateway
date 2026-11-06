import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PHOTO_MAX_BYTES } from "./format.js";

/** Complete ```mermaid / ~~~mermaid fences. A fence that never closes is left as source. */
const OPEN_FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i;
const ANY_FENCE = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MERMAID_SOURCE_MAX = 100_000;

export function defaultMermaidBin(dataDir) {
  return join(dataDir, "mermaid", "node_modules", ".bin", "mmdc");
}

function closingFence(line, marker) {
  const match = /^[ \t]{0,3}(`+|~+)[ \t]*$/.exec(line);
  if (!match) return false;
  const token = match[1];
  return token[0] === marker[0] && token.length >= marker.length;
}

function dedent(source, indent) {
  if (!indent) return source;
  return source
    .split("\n")
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n");
}

function safeImagePath(filePath) {
  return typeof filePath === "string"
    && filePath.startsWith("/")
    && !/[\s)"'`]/.test(filePath)
    && !filePath.includes("\0");
}

/**
 * Replace each finished Mermaid fence with `![圖表](path)` at the same place.
 * `render` returns an absolute PNG path, or null to keep the source fence.
 * An unfinished fence at the end of a stream is not rendered.
 */
export async function embedMermaid(text, render) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inFence = null;
  while (i < lines.length) {
    if (inFence) {
      out.push(lines[i]);
      if (closingFence(lines[i], inFence)) inFence = null;
      i += 1;
      continue;
    }
    const open = OPEN_FENCE.exec(lines[i]);
    if (!open) {
      const other = ANY_FENCE.exec(lines[i]);
      if (other) inFence = other[2];
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !closingFence(lines[end], open[2])) end += 1;
    if (end >= lines.length) {
      out.push(...lines.slice(i));
      break;
    }
    const source = dedent(lines.slice(i + 1, end).join("\n"), open[1]);
    let image = null;
    if (source.trim()) {
      try {
        image = await render(source);
      } catch {
        image = null;
      }
    }
    if (safeImagePath(image)) out.push(`${open[1]}![圖表](${image})`);
    else out.push(...lines.slice(i, end + 1));
    i = end + 1;
  }
  return out.join("\n");
}

async function validPng(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (info.size <= 8 || info.size > LOCAL_PHOTO_MAX_BYTES) return false;
    const buf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buf, 0, 8, 0);
    return bytesRead === 8 && buf.equals(PNG_MAGIC);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function runRenderer(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    let stderrBytes = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error("mermaid renderer timed out")));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      if (stderrBytes > 4000) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      if (code === 0) finish(() => resolve());
      else {
        const detail = Buffer.concat(stderr).toString().trim().slice(0, 500);
        finish(() => reject(new Error(detail || `mermaid renderer exit ${code ?? signal}`)));
      }
    });
  });
}

/**
 * Render one diagram to a cached PNG under cacheDir. The same source is not
 * rendered twice. A failed source is not retried until the process restarts.
 */
export function createMermaidRenderer({
  bin,
  cacheDir,
  configPath,
  puppeteerConfigPath,
  timeoutMs = 30_000,
  size = "800",
  scale = "2",
  onError = () => {},
} = {}) {
  const pending = new Map();
  const failed = new Set();
  let missingBin = false;

  async function renderOnce(source, dest) {
    try {
      await access(bin);
    } catch (error) {
      missingBin = true;
      const missing = new Error(`mermaid renderer missing: ${bin}`);
      missing.cause = error;
      throw missing;
    }
    await mkdir(cacheDir, { recursive: true, mode: 0o755 });
    const dir = await mkdtemp(join(tmpdir(), "omb-mermaid-"));
    try {
      const input = join(dir, "diagram.mmd");
      const output = join(dir, "diagram.png");
      await writeFile(input, source, { mode: 0o600 });
      const args = ["-i", input, "-o", output, "-e", "png", "-b", "white", "-s", String(scale), "--size", String(size), "-q"];
      if (configPath) args.push("-c", configPath);
      if (puppeteerConfigPath) args.push("-p", puppeteerConfigPath);
      await runRenderer(bin, args, timeoutMs);
      const bytes = await readFile(output);
      if (bytes.length <= 8 || bytes.length > LOCAL_PHOTO_MAX_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
        throw new Error("mermaid renderer did not write a png");
      }
      const tmp = join(cacheDir, `.${dest.split("/").at(-1)}.${process.pid}.tmp`);
      try {
        await writeFile(tmp, bytes, { mode: 0o644 });
        await rename(tmp, dest);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
      return dest;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return async function render(source) {
    const body = String(source ?? "");
    if (!body.trim() || body.length > MERMAID_SOURCE_MAX) return null;
    if (missingBin) return null;
    const name = `${createHash("sha256").update(body).digest("hex").slice(0, 32)}.png`;
    const dest = join(cacheDir, name);
    if (failed.has(name)) return null;
    if (await validPng(dest)) return dest;
    let job = pending.get(name);
    if (!job) {
      job = renderOnce(body, dest).then(
        (path) => path,
        (error) => {
          failed.add(name);
          onError(error);
          return null;
        },
      ).finally(() => pending.delete(name));
      pending.set(name, job);
    }
    return job;
  };
}
