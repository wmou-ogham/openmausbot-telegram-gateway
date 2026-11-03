import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** Apply KEY=VALUE lines. Variables already in the environment win. */
export function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Substitute @NAME@ markers. Values are single-line so they can sit in systemd and YAML. */
export function renderTemplate(template, values) {
  let out = String(template);
  for (const [key, raw] of Object.entries(values)) {
    const value = raw == null ? "" : String(raw);
    if (/[\n\r]/.test(value)) throw new Error(`${key} must be a single line`);
    out = out.split(`@${key}@`).join(value);
  }
  const left = out.match(/@[A-Z0-9_]+@/g);
  if (left) throw new Error(`unsubstituted ${[...new Set(left)].join(", ")}`);
  return out.endsWith("\n") ? out : `${out}\n`;
}

export function hostConfig(here) {
  const prefix = (process.env.OMB_IMAGE_PREFIX || "/omb-img").trim() || "/omb-img";
  return {
    serviceUser: process.env.OMB_SERVICE_USER || userInfo().username,
    serviceHome: process.env.OMB_SERVICE_HOME || homedir(),
    gatewayDir: process.env.OMB_GATEWAY_DIR || here,
    dataDir: process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot"),
    serverUrl: process.env.OMB_SERVER_URL || "http://127.0.0.1:8799",
    nodeBin: process.env.OMB_NODE_BIN || process.execPath,
    path: process.env.OMB_PATH || process.env.PATH || "/usr/bin:/bin",
    imagePublishDir: (process.env.OMB_IMAGE_PUBLISH_DIR || "").trim(),
    imagePublicBase: (process.env.OMB_IMAGE_PUBLIC_BASE || "").trim().replace(/\/+$/, ""),
    imageContainer: (process.env.OMB_IMAGE_CONTAINER || "").trim(),
    imageNetwork: (process.env.OMB_IMAGE_NETWORK || "").trim(),
    imageHost: (process.env.OMB_IMAGE_HOST || "").trim(),
    imagePrefix: prefix.startsWith("/") ? prefix.replace(/\/+$/, "") : `/${prefix.replace(/\/+$/, "")}`,
    imageComposeDest: (process.env.OMB_IMAGE_COMPOSE_DEST || "").trim(),
    imageTraefikDest: (process.env.OMB_IMAGE_TRAEFIK_DEST || "").trim(),
  };
}

export function unitValues(cfg) {
  return {
    OMB_SERVICE_USER: cfg.serviceUser,
    OMB_SERVICE_HOME: cfg.serviceHome,
    OMB_GATEWAY_DIR: cfg.gatewayDir,
    OMB_DATA_DIR: cfg.dataDir,
    OMB_SERVER_URL: cfg.serverUrl,
    OMB_NODE_BIN: cfg.nodeBin,
    OMB_PATH: cfg.path,
    OMB_IMAGE_PUBLISH_DIR: cfg.imagePublishDir,
    OMB_IMAGE_PUBLIC_BASE: cfg.imagePublicBase,
  };
}

export function imageHostValues(cfg) {
  const names = ["imagePublishDir", "imagePublicBase", "imageContainer", "imageNetwork", "imageHost"];
  const missing = names.filter((name) => !cfg[name]);
  if (missing.length) return null;
  if (!/^\/[A-Za-z0-9_./-]+$/.test(cfg.imagePrefix)) {
    throw new Error("OMB_IMAGE_PREFIX must be an absolute path prefix");
  }
  return {
    OMB_IMAGE_CONTAINER: cfg.imageContainer,
    OMB_IMAGE_NETWORK: cfg.imageNetwork,
    OMB_IMAGE_PUBLISH_DIR: cfg.imagePublishDir,
    OMB_IMAGE_HOST: cfg.imageHost,
    OMB_IMAGE_PREFIX: cfg.imagePrefix,
    OMB_IMAGE_PUBLIC_BASE: cfg.imagePublicBase,
  };
}
