// Calling Jev, and turning its failures into something the app can act on.

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-1.14.0"; // Box questions need 1.14
export const PRICE_PER_TOKEN = 0.042 / 1e6; // USD per input token; output tokens are free

// Jev doesn't document its out-of-credit response, so match the words it is likely to use.
const DEPLETED = /credit|balance|billing|payment|insufficient|quota|funds|top.?up|spend/i;

/** One of: depleted, auth, busy, bad_image, jev_error. */
export function classifyJevError(status, body) {
  const detail = body?.detail ?? body?.error ?? body;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  if (status === 402 || DEPLETED.test(text)) return "depleted";
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 503 || status === 529) return "busy";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "bad_image";
  return "jev_error";
}

/**
 * POST to Jev. Never throws: returns { ok: true, ms, requestId, model, answers, usage }
 * or { ok: false, kind, status, ms, requestId, errorType, message }, where kind is a
 * classifyJevError() result, "timeout", or "auth" for a missing key.
 */
export async function askJev(env, payload, { images = false, timeout = 15_000 } = {}) {
  if (!env.TYPESAFE_API_KEY) {
    return { ok: false, kind: "auth", status: 0, ms: 0, errorType: "missing_key", message: "TYPESAFE_API_KEY is not set" };
  }
  const headers = { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" };
  if (images) headers["TypeSafe-Danger-Zone-Images"] = "true";

  const started = Date.now();
  let res;
  try {
    res = await fetch(env.JEV_URL || JEV_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError";
    return { ok: false, kind: timedOut ? "timeout" : "jev_error", status: 0, ms: Date.now() - started, message: String(e) };
  }
  const ms = Date.now() - started;
  const requestId = res.headers.get("x-typesafe-request-id");
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    const d = body?.detail;
    const message = typeof d?.message === "string" ? d.message : typeof d === "string" ? d : text;
    return {
      ok: false,
      kind: classifyJevError(res.status, body),
      status: res.status,
      ms,
      requestId,
      errorType: d?.error_type,
      message: message.slice(0, 300),
    };
  }
  return { ok: true, status: res.status, ms, requestId, ...body };
}
