import { test } from "node:test";
import assert from "node:assert/strict";
import { envSha256, parseCsv, planActions, renderEnv, resolveRows } from "./refresh.js";

const BOTS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Alpha" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Beta" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Gamma" },
];

const CSV = [
  "instance,harness_bot,allow_username,state_path,replaces,token",
  "alpha,Alpha,alice,/tmp/telegram-gateway.json,openmausbot-telegram.service,100:AA_alpha_token_placeholder_xx",
  "gamma,Gamma,alice,,,200:AA_gamma_token_placeholder_xxxx",
].join("\n");

test("parseCsv skips comments and keeps columns", () => {
  const rows = parseCsv(`# comment\n${CSV}`);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].instance, "gamma");
  assert.equal(rows[1].replaces, "");
});

test("resolveRows maps names, defaults state path, rejects duplicate tokens", () => {
  const rows = resolveRows(parseCsv(CSV), BOTS, "/data");
  assert.equal(rows[1].botId, "33333333-3333-4333-8333-333333333333");
  assert.equal(rows[1].statePath, "/data/telegram-gateway-gamma.json");
  const dup = parseCsv(CSV).map((row) => ({ ...row, token: "100:AA_alpha_token_placeholder_xx" }));
  assert.throws(() => resolveRows(dup, BOTS, "/data"), /duplicate token/);
});

test("resolveRows requires allow_username", () => {
  const rows = parseCsv(CSV).map((row) => ({ ...row, allow_username: "" }));
  assert.throws(() => resolveRows(rows, BOTS, "/data"), /allow_username is required/);
});

test("planActions restarts on hash change, a new unit, and stops a live legacy unit", () => {
  const rows = resolveRows(parseCsv(CSV), BOTS, "/data").map((row) => ({
    ...row,
    sha256: "new",
    telegram: "bot",
  }));
  const actions = planActions(rows, {
    activeUnits: new Set(["openmausbot-telegram@alpha.service", "openmausbot-telegram.service"]),
    enabledUnits: new Set(["openmausbot-telegram@alpha.service", "openmausbot-telegram.service"]),
    applied: { units: { alpha: { sha256: "old" }, gone: { sha256: "x" } } },
    unitChanged: true,
  });
  const alpha = actions.find((action) => action.instance === "alpha");
  assert.equal(alpha.start, "restart");
  assert.equal(alpha.stopLegacy, "openmausbot-telegram.service");
  const gamma = actions.find((action) => action.instance === "gamma");
  assert.equal(gamma.start, "enable-now");
  assert.equal(actions.find((action) => action.instance === "gone").start, "disable");
});

test("planActions restarts a live instance when only the unit template changed", () => {
  const rows = resolveRows(parseCsv(CSV), BOTS, "/data").map((row) => ({
    ...row,
    sha256: "same",
    telegram: "bot",
  }));
  const actions = planActions(rows.slice(0, 1), {
    activeUnits: new Set(["openmausbot-telegram@alpha.service"]),
    enabledUnits: new Set(["openmausbot-telegram@alpha.service"]),
    applied: { units: { alpha: { sha256: "same" } } },
    unitChanged: true,
  });
  assert.equal(actions[0].start, "restart");
});

test("renderEnv hash ignores nothing that systemd will read", () => {
  const body = renderEnv({
    token: "100:AA_alpha_token_placeholder_xx",
    botId: "11111111-1111-4111-8111-111111111111",
    allowUsername: "alice",
    statePath: "/tmp/telegram-gateway.json",
  });
  assert.match(body, /^TELEGRAM_BOT_TOKEN=/);
  assert.equal(envSha256(body), envSha256(body));
  assert.notEqual(envSha256(body), envSha256(body.replace("alice", "other")));
});
