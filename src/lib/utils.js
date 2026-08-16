// ─── FORMATTING & UTILITIES ──────────────────────────────────────────────
// Pure helpers, copied VERBATIM from the original widget (no DOM access).

export function formatCurrency(amount) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(amount) || 0);
}

export function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function makeApplicationId() { return `WG-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`; }
export function uid(prefix)         { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function getByPath(source, path) {
  return path.split(".").reduce((obj, key) => obj?.[key], source);
}

export function setByPath(source, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((obj, key) => {
    if (/^\d+$/.test(key)) return obj[Number(key)];
    if (!obj[key]) obj[key] = {};
    return obj[key];
  }, source);
  target[last] = value;
}

export function mergeDeep(target, source) {
  Object.keys(source || {}).forEach((key) => {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      target[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  });
  return target;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
}

export function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("Could not parse JSON response", error);
    return null;
  }
}

export function parseJsonMaybe(value) {
  if (!value || typeof value !== "string") return value;
  let parsed = value;
  for (let i = 0; i < 2; i++) {
    if (typeof parsed !== "string") return parsed;
    try { parsed = JSON.parse(parsed); } catch (error) { return parsed; }
  }
  return parsed;
}
