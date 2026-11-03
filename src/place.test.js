import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLocation, consumeStop, locationPrefix, takeLocations } from "./place.js";

test("a live location is announced once and later edits stay quiet", () => {
  const first = applyLocation(null, {
    message_id: 7,
    date: 1_700_000_000,
    location: { latitude: 25.033, longitude: 121.565, live_period: 3600, horizontal_accuracy: 12 },
  });
  assert.match(first.announce, /即時位置/);
  assert.equal(first.state.active, true);
  const moved = applyLocation(first.state, {
    message_id: 7,
    date: 1_700_000_000,
    edit_date: 1_700_000_100,
    location: { latitude: 25.04, longitude: 121.57, live_period: 3600, heading: 90 },
  });
  assert.equal(moved.announce, null);
  assert.match(locationPrefix(moved.state), /目前位置/);
  assert.match(locationPrefix(moved.state), /25\.04000, 121\.57000/);
});

test("stopping a live share is reported once on the next message", () => {
  const started = applyLocation(null, {
    message_id: 7,
    date: 10,
    location: { latitude: 1, longitude: 2, live_period: 60 },
  });
  const stopped = applyLocation(started.state, {
    message_id: 7,
    date: 10,
    edit_date: 20,
    location: { latitude: 1.5, longitude: 2.5 },
  });
  assert.equal(stopped.announce, null);
  assert.match(locationPrefix(stopped.state), /已停止/);
  assert.equal(locationPrefix(consumeStop(stopped.state)), "");
});

test("a static pin is announced and not treated as live", () => {
  const pin = applyLocation(null, {
    message_id: 3,
    date: 10,
    location: { latitude: 25, longitude: 121 },
  });
  assert.match(pin.announce, /^\[位置\]/);
  assert.equal(pin.state.active, false);
  assert.equal(locationPrefix(pin.state), "");
});

test("takeLocations keeps a valid tag and drops it from the visible text", () => {
  const taken = takeLocations('走這邊\n<telegram-location latitude="25.033" longitude="121.565" title="藥局" address="台北" />');
  assert.equal(taken.locations[0].title, "藥局");
  assert.equal(taken.locations[0].latitude, 25.033);
  assert.equal(taken.text.trim(), "走這邊");
});

test("an impossible coordinate stays in the text", () => {
  const taken = takeLocations('<telegram-location latitude="120" longitude="10" />');
  assert.equal(taken.locations.length, 0);
  assert.match(taken.text, /telegram-location/);
});
