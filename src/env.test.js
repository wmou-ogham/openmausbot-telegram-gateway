import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageHostValues, loadEnvFile, renderTemplate } from "./env.js";

test("loadEnvFile fills missing keys and does not override the environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omb-env-"));
  const path = join(dir, ".env");
  await writeFile(path, "# comment\nexport OMB_ENV_TEST_NEW=from-file\nOMB_ENV_TEST_OLD=file\n");
  process.env.OMB_ENV_TEST_OLD = "process";
  delete process.env.OMB_ENV_TEST_NEW;
  loadEnvFile(path);
  assert.equal(process.env.OMB_ENV_TEST_NEW, "from-file");
  assert.equal(process.env.OMB_ENV_TEST_OLD, "process");
  delete process.env.OMB_ENV_TEST_NEW;
  delete process.env.OMB_ENV_TEST_OLD;
});

test("renderTemplate substitutes every marker", () => {
  const text = renderTemplate("User=@OMB_SERVICE_USER@\n", { OMB_SERVICE_USER: "app" });
  assert.equal(text, "User=app\n");
  assert.throws(() => renderTemplate("@OMB_LEFT@\n", {}), /unsubstituted/);
});

test("imageHostValues stays empty until the bed is configured", () => {
  assert.equal(imageHostValues({
    imagePublishDir: "",
    imagePublicBase: "",
    imageContainer: "",
    imageNetwork: "",
    imageHost: "",
    imagePrefix: "/omb-img",
  }), null);
  const values = imageHostValues({
    imagePublishDir: "/var/lib/omb-img",
    imagePublicBase: "https://img.example/bed",
    imageContainer: "omb-img",
    imageNetwork: "edge",
    imageHost: "img.example",
    imagePrefix: "/bed",
  });
  assert.equal(values.OMB_IMAGE_HOST, "img.example");
  assert.equal(values.OMB_IMAGE_PREFIX, "/bed");
});
