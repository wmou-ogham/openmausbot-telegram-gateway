#!/usr/bin/env node
// Read bots.csv and reconcile one systemd instance per row.
// Tokens stay in ~/.openmausbot/telegram-bots/<instance>.env (mode 600).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostConfig, imageHostValues, loadEnvFile, renderTemplate, unitValues } from "./src/env.js";

setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(HERE, ".env"));
const HOST = hostConfig(HERE);
const DATA_DIR = HOST.dataDir;
const SERVER = HOST.serverUrl;
const BOTS_DIR = join(DATA_DIR, "telegram-bots");
const APPLIED_PATH = join(BOTS_DIR, "applied.json");
const UNIT_TEMPLATE = join(HERE, "deploy", "openmausbot-telegram@.service.in");
const UNIT_DEST = "/etc/systemd/system/openmausbot-telegram@.service";
const COLUMNS = ["instance", "harness_bot", "allow_username", "state_path", "replaces", "token"];
const INSTANCE_RE = /^[a-z][a-z0-9-]{0,30}$/;
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIT_RE = /^[a-zA-Z0-9:._@-]+\.service$/;

export function parseCsv(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("bots.csv is empty");
  const header = splitCsvLine(lines[0]);
  const missing = COLUMNS.filter((name) => !header.includes(name));
  if (missing.length) throw new Error(`bots.csv missing columns: ${missing.join(", ")}`);
  const unknown = header.filter((name) => !COLUMNS.includes(name));
  if (unknown.length) throw new Error(`bots.csv has unknown columns: ${unknown.join(", ")}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length !== header.length) {
      throw new Error(`bots.csv row ${i + 1} has ${cells.length} columns, header has ${header.length}`);
    }
    const row = {};
    header.forEach((name, idx) => {
      row[name] = cells[idx];
    });
    rows.push(row);
  }
  if (!rows.length) throw new Error("bots.csv has no rows");
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function resolveRows(rawRows, bots, dataDir = DATA_DIR) {
  const resolved = [];
  const seenInstance = new Set();
  const seenToken = new Set();
  const seenBot = new Set();
  for (const raw of rawRows) {
    const instance = raw.instance;
    if (!INSTANCE_RE.test(instance)) throw new Error(`bad instance name: ${instance || "(empty)"}`);
    if (seenInstance.has(instance)) throw new Error(`duplicate instance: ${instance}`);
    seenInstance.add(instance);
    if (!TOKEN_RE.test(raw.token)) throw new Error(`bad token for instance ${instance}`);
    if (seenToken.has(raw.token)) throw new Error(`duplicate token for instance ${instance}`);
    seenToken.add(raw.token);
    const bot = resolveHarness(raw.harness_bot, bots);
    if (seenBot.has(bot.id)) throw new Error(`duplicate harness bot ${bot.name} (${bot.id})`);
    seenBot.add(bot.id);
    const allow = raw.allow_username;
    if (!allow) throw new Error(`allow_username is required for ${instance}`);
    if (!/^[A-Za-z0-9_]{4,32}$/.test(allow)) throw new Error(`bad allow_username for ${instance}`);
    let statePath = raw.state_path;
    if (!statePath) statePath = join(dataDir, `telegram-gateway-${instance}.json`);
    if (!statePath.startsWith("/") || statePath.includes("\n")) {
      throw new Error(`state_path for ${instance} must be absolute`);
    }
    const replaces = raw.replaces || "";
    if (replaces && !UNIT_RE.test(replaces)) throw new Error(`bad replaces unit for ${instance}`);
    resolved.push({
      instance,
      botId: bot.id,
      botName: bot.name,
      allowUsername: allow,
      statePath,
      replaces,
      token: raw.token,
    });
  }
  return resolved;
}

function resolveHarness(spec, bots) {
  if (!spec) throw new Error("harness_bot is empty");
  if (UUID_RE.test(spec)) {
    const hit = bots.find((bot) => bot.id === spec);
    if (!hit) throw new Error(`harness bot id ${spec} is not on the harness`);
    return hit;
  }
  const matches = bots.filter((bot) => String(bot.name).toLowerCase() === spec.toLowerCase());
  if (matches.length !== 1) {
    throw new Error(`harness bot ${spec} matched ${matches.length} bots`);
  }
  return matches[0];
}

export function renderEnv(row) {
  return [
    `TELEGRAM_BOT_TOKEN=${row.token}`,
    `OMB_TELEGRAM_BOT_ID=${row.botId}`,
    `OMB_TELEGRAM_ALLOW_USERNAME=${row.allowUsername}`,
    `OMB_TELEGRAM_STATE_PATH=${row.statePath}`,
    "",
  ].join("\n");
}

export function envSha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

export function planActions(rows, { activeUnits, enabledUnits, applied, unitChanged = false }) {
  const actions = [];
  for (const row of rows) {
    const unit = `openmausbot-telegram@${row.instance}.service`;
    const prev = applied.units?.[row.instance]?.sha256;
    const hashChanged = prev !== row.sha256;
    const unitActive = activeUnits.has(unit);
    const legacyLive = row.replaces && (activeUnits.has(row.replaces) || enabledUnits.has(row.replaces));
    let start = null;
    if (hashChanged && unitActive) start = "restart";
    else if (!unitActive) start = "enable-now";
    else if (!enabledUnits.has(unit)) start = "enable";
    else if (unitChanged && unitActive) start = "restart";
    actions.push({
      instance: row.instance,
      unit,
      stopLegacy: legacyLive ? row.replaces : null,
      start,
      sha256: row.sha256,
      botId: row.botId,
      botName: row.botName,
      telegram: row.telegram ?? "",
    });
  }
  const keep = new Set(rows.map((row) => row.instance));
  for (const name of Object.keys(applied.units ?? {})) {
    if (!keep.has(name)) {
      actions.push({
        instance: name,
        unit: `openmausbot-telegram@${name}.service`,
        stopLegacy: null,
        start: "disable",
        sha256: null,
        botId: "",
        botName: "",
        telegram: "",
      });
    }
  }
  return actions;
}

function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function sudoSystemctl(args) {
  const result = await run("sudo", ["-n", "systemctl", ...args]);
  if (result.code !== 0) {
    throw new Error(`systemctl ${args.join(" ")} → ${result.code} ${result.err || result.out}`.trim());
  }
}

async function unitFlags(name) {
  const active = await run("systemctl", ["is-active", name]);
  const enabled = await run("systemctl", ["is-enabled", name]);
  return { active: active.code === 0, enabled: enabled.code === 0 };
}

async function loadBots() {
  const res = await fetch(`${SERVER}/api/bots`);
  if (!res.ok) throw new Error(`/api/bots → ${res.status}`);
  const body = await res.json();
  return body.bots ?? [];
}

async function telegramUsername(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    throw new Error(redact(body.description ?? res.status, [token]));
  }
  return body.result?.username ?? "";
}

function loadApplied() {
  try {
    return JSON.parse(readFileSync(APPLIED_PATH, "utf8"));
  } catch {
    return { units: {} };
  }
}

function writeSecret(path, body) {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeIfChanged(path, body) {
  let prev = "";
  try {
    prev = readFileSync(path, "utf8");
  } catch {
    /* new file */
  }
  if (prev === body) return false;
  writeFileSync(path, body);
  return true;
}

async function installUnit(rendered) {
  let prev = "";
  try {
    prev = readFileSync(UNIT_DEST, "utf8");
  } catch {
    /* not installed yet */
  }
  if (prev === rendered) return false;
  const tmp = join(tmpdir(), `openmausbot-telegram-unit-${process.pid}.service`);
  writeFileSync(tmp, rendered, { mode: 0o644 });
  try {
    const installed = await run("sudo", ["-n", "install", "-m", "644", tmp, UNIT_DEST]);
    if (installed.code !== 0) {
      throw new Error(`install template → ${installed.code} ${installed.err || installed.out}`.trim());
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already removed */
    }
  }
  return true;
}

async function syncImageHost() {
  const dests = [
    [HOST.imageComposeDest, join(HERE, "deploy", "image-host", "compose.yml.in")],
    [HOST.imageTraefikDest, join(HERE, "deploy", "image-host", "omb-img.yml.in")],
  ].filter(([dest]) => dest);
  if (!dests.length) return;
  const values = imageHostValues(HOST);
  if (!values) throw new Error("OMB_IMAGE_COMPOSE_DEST or OMB_IMAGE_TRAEFIK_DEST is set, but the image bed settings are incomplete");
  let composeChanged = false;
  for (const [dest, templatePath] of dests) {
    const rendered = renderTemplate(readFileSync(templatePath, "utf8"), values);
    if (!writeIfChanged(dest, rendered)) continue;
    console.log(`wrote ${dest}`);
    if (dest === HOST.imageComposeDest) composeChanged = true;
  }
  if (!composeChanged) return;
  const up = await run("docker", ["compose", "-f", HOST.imageComposeDest, "up", "-d"]);
  if (up.code !== 0) {
    throw new Error(`image host compose → ${up.code} ${up.err || up.out}`.trim());
  }
}

async function main() {
  let secrets = [];
  try {
    const csvPath = process.argv[2] ?? join(HERE, "bots.csv");
    const raw = parseCsv(readFileSync(csvPath, "utf8"));
    secrets = raw.map((row) => row.token).filter(Boolean);
    const bots = await loadBots();
    const resolved = resolveRows(raw, bots);
    for (const row of resolved) {
      try {
        row.telegram = await telegramUsername(row.token);
      } catch (err) {
        throw new Error(`getMe ${row.instance}: ${redact(err.message, secrets)}`);
      }
      row.envBody = renderEnv(row);
      row.sha256 = envSha256(row.envBody);
    }
    mkdirSync(BOTS_DIR, { recursive: true, mode: 0o700 });
    chmodSync(BOTS_DIR, 0o700);
    for (const row of resolved) {
      const path = join(BOTS_DIR, `${row.instance}.env`);
      let prev = "";
      try {
        prev = readFileSync(path, "utf8");
      } catch {
        /* new */
      }
      if (prev !== row.envBody) writeSecret(path, row.envBody);
    }
    const renderedUnit = renderTemplate(readFileSync(UNIT_TEMPLATE, "utf8"), unitValues(HOST));
    const unitChanged = await installUnit(renderedUnit);
    if (unitChanged) await sudoSystemctl(["daemon-reload"]);

    const applied = loadApplied();
    const names = new Set([
      ...resolved.flatMap((row) => [row.instance, row.replaces].filter(Boolean)),
      ...Object.keys(applied.units ?? {}),
    ]);
    const activeUnits = new Set();
    const enabledUnits = new Set();
    for (const name of names) {
      const unit = name.endsWith(".service") ? name : `openmausbot-telegram@${name}.service`;
      const flags = await unitFlags(unit);
      if (flags.active) activeUnits.add(unit);
      if (flags.enabled) enabledUnits.add(unit);
    }
    const actions = planActions(resolved, { activeUnits, enabledUnits, applied, unitChanged });
    const nextApplied = { units: {} };
    for (const action of actions) {
      if (action.start === "disable") {
        await sudoSystemctl(["disable", "--now", action.unit]);
        console.log(`disabled ${action.unit} (removed from bots.csv; env file left in place)`);
        continue;
      }
      if (action.stopLegacy) {
        await sudoSystemctl(["disable", "--now", action.stopLegacy]);
        console.log(`stopped legacy ${action.stopLegacy}`);
      }
      if (action.start === "restart") await sudoSystemctl(["restart", action.unit]);
      else if (action.start === "enable-now") await sudoSystemctl(["enable", "--now", action.unit]);
      else if (action.start === "enable") await sudoSystemctl(["enable", action.unit]);
      if (action.start === "restart" || action.start === "enable-now") {
        const flags = await unitFlags(action.unit);
        if (!flags.active) {
          if (action.stopLegacy) {
            await sudoSystemctl(["enable", "--now", action.stopLegacy]);
            console.error(`rolled back to ${action.stopLegacy}`);
          }
          throw new Error(`${action.unit} did not become active`);
        }
      }
      nextApplied.units[action.instance] = {
        sha256: action.sha256,
        botId: action.botId,
        botName: action.botName,
        telegram: action.telegram,
      };
      const verb = action.start ?? "unchanged";
      console.log(`${action.instance}: @${action.telegram} → ${action.botName} (${action.botId}) ${verb}`);
    }
    writeSecret(APPLIED_PATH, `${JSON.stringify(nextApplied, null, 2)}\n`);
    await syncImageHost();
  } catch (err) {
    console.error(redact(err?.message ?? err, secrets));
    process.exit(1);
  }
}

const invoked = process.argv[1] && /refresh\.js$/.test(process.argv[1]);
if (invoked) {
  main();
}
