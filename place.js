/** Telegram location / live location, and the tag OpenMaus uses to send one back. */

const TAG = /<telegram-location\b([^>\n]*)\/?>/gi;

export function formatCoordinate(latitude, longitude) {
  return `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
}

function accuracy(location) {
  return typeof location.horizontal_accuracy === "number"
    ? `，精度約 ${Math.round(location.horizontal_accuracy)} 公尺`
    : "";
}

function heading(location) {
  return typeof location.heading === "number" ? `，方向 ${Math.round(location.heading)}°` : "";
}

export function describeLocation(message) {
  const venue = message?.venue;
  const location = venue?.location ?? message?.location;
  if (!location || typeof location.latitude !== "number") return "";
  const point = formatCoordinate(location.latitude, location.longitude);
  if (venue) return `[地標] ${venue.title ?? "地點"}${venue.address ? `，${venue.address}` : ""}（${point}）`;
  const live = typeof location.live_period === "number" && location.live_period > 0;
  return `[${live ? "即時位置" : "位置"}] ${point}${accuracy(location)}${heading(location)}`;
}

/** Fold one inbound location message into the remembered fix.
 * Live updates of the same Telegram message do not start a new turn. */
export function applyLocation(previous, message) {
  const venue = message?.venue;
  const location = venue?.location ?? message?.location;
  if (!location || typeof location.latitude !== "number" || typeof location.longitude !== "number") {
    return { state: previous ?? null, announce: null };
  }
  const live = !venue && typeof location.live_period === "number" && location.live_period > 0;
  const sameAnchor = Boolean(previous && message.edit_date && message.message_id === previous.anchorId);
  const stopped = Boolean(sameAnchor && previous.active && !live);
  const state = {
    latitude: location.latitude,
    longitude: location.longitude,
    horizontalAccuracy: typeof location.horizontal_accuracy === "number" ? location.horizontal_accuracy : null,
    heading: typeof location.heading === "number" ? location.heading : null,
    updatedAt: (message.edit_date ?? message.date ?? Math.floor(Date.now() / 1000)) * 1000,
    anchorId: message.message_id,
    active: live,
    stopped,
    title: venue?.title ?? null,
    address: venue?.address ?? null,
  };
  if (sameAnchor) return { state, announce: null };
  return { state, announce: describeLocation(message) };
}

export function locationPrefix(state) {
  if (!state) return "";
  const point = formatCoordinate(state.latitude, state.longitude);
  const acc = typeof state.horizontalAccuracy === "number" ? `，精度約 ${Math.round(state.horizontalAccuracy)} 公尺` : "";
  const head = typeof state.heading === "number" ? `，方向 ${Math.round(state.heading)}°` : "";
  if (state.active) return `[目前位置] ${point}${acc}${head}`;
  if (state.stopped) return `[即時位置已停止] 最後是 ${point}${acc}${head}`;
  return "";
}

export function consumeStop(state) {
  if (!state?.stopped) return state ?? null;
  return { ...state, stopped: false };
}

function attribute(source, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return match ? match[1] : "";
}

export function takeLocations(text) {
  const locations = [];
  const cleaned = String(text ?? "").replace(TAG, (full, attrs) => {
    const latitude = Number(attribute(attrs, "latitude"));
    const longitude = Number(attribute(attrs, "longitude"));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return full;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return full;
    locations.push({
      latitude,
      longitude,
      title: attribute(attrs, "title").trim(),
      address: attribute(attrs, "address").trim(),
    });
    return "";
  });
  return { text: cleaned, locations };
}
