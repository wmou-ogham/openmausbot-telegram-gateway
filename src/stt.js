/** Local Whisper for Telegram voice. One process for the life of this gateway. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

export function defaultPythonPath(dataDir = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot")) {
  return process.env.OMB_STT_PYTHON ?? join(dataDir, "stt", "venv", "bin", "python");
}

export function createTranscriber(options = {}) {
  const python = options.pythonPath ?? defaultPythonPath(options.dataDir);
  const script = options.scriptPath ?? join(HERE, "..", "stt", "worker.py");
  const dataDir = options.dataDir ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
  let child = null;
  let starting = null;
  let seq = 0;
  const pending = new Map();

  const failAll = (error) => {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    pending.clear();
    child = null;
    starting = null;
  };

  const ensure = () => {
    if (child && starting) return starting;
    if (!existsSync(python) || !existsSync(script)) {
      return Promise.reject(new Error("本機語音轉文字還沒安裝。在 openmausbot-telegram-gateway 執行 stt/setup.sh"));
    }
    const proc = spawn(python, [script], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        OMB_DATA_DIR: dataDir,
        OMB_STT_CACHE: process.env.OMB_STT_CACHE ?? join(dataDir, "stt", "cache"),
      },
    });
    child = proc;
    starting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("語音模型載入超過 20 分鐘"));
      }, JOB_TIMEOUT_MS);
      const lines = createInterface({ input: proc.stdout });
      const onReady = (line) => {
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          return;
        }
        if (!payload.ready) {
          clearTimeout(timer);
          reject(new Error(payload.error || "語音模型沒有啟動"));
          return;
        }
        clearTimeout(timer);
        lines.removeListener("line", onReady);
        lines.on("line", (next) => {
          let body;
          try {
            body = JSON.parse(next);
          } catch {
            return;
          }
          if (body.id === undefined) return;
          const job = pending.get(body.id);
          if (!job) return;
          pending.delete(body.id);
          clearTimeout(job.timer);
          if (body.error) job.reject(new Error(body.error));
          else job.resolve(body.text ?? "");
        });
        resolve();
      };
      lines.on("line", onReady);
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.once("exit", (code) => {
        failAll(new Error(`語音轉文字行程結束（${code ?? "無結束碼"}）`));
      });
    });
    starting.catch(() => {
      child = null;
      starting = null;
    });
    return starting;
  };

  return {
    async transcribe(filePath) {
      await ensure();
      const stdin = child?.stdin;
      if (!stdin) throw new Error("語音轉文字沒有在執行");
      const id = ++seq;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("語音轉文字超過 20 分鐘"));
        }, JOB_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        stdin.write(`${JSON.stringify({ id, path: filePath })}\n`);
      });
    },
    stop() {
      child?.kill();
      child = null;
      starting = null;
    },
  };
}
