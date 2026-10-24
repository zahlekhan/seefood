// SeeFood API: one photo in, one Jev 1.14 call out. The key never leaves the Worker.

import { askJev, MODEL, PRICE_PER_TOKEN } from "./jev.js";
export { Monitor } from "./monitor.js";

// The entire product. Jian-Yang would insist it stays this small.
const QUESTIONS = {
  hotdog: { type: "noul", instructions: "Is `photo` a picture of a hot dog?" },
  where: { type: "box", instructions: "the hot dog in `photo`" },
  obscene: {
    type: "noul",
    instructions: "Is `photo` obscene or offensive to show publicly?",
    criteria: {
      true: "Nudity or exposed genitals, sexual acts or sexual poses, obscene gestures such as the middle finger, graphic gore, or profane, slur or hateful words or symbols anywhere in the photo, including on signs, clothing or food.",
      false: "An ordinary photo of food, people, places, animals or objects. Hot dogs, sausages and bananas are just food.",
    },
  },
};
const HOTDOG_AT = 0.5;
const OBSCENE_AT = 0.35; // block early: a false "not allowed" is cheaper than an obscene share card
const MAX_BASE64 = 4_000_000; // the client sends ≤1024px JPEGs, well under this
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const LIVE_LOG_SAMPLE = 0.1; // live mode sends ~2 frames/s; log 1 in 10 successful frames

// Jev failure -> [HTTP status, code]. What users read for each code lives in public/app.js.
const FAILURES = {
  depleted: [503, "out_of_credits"],
  auth: [503, "unavailable"],
  busy: [503, "busy"],
  timeout: [504, "timeout"],
  bad_image: [422, "bad_image"],
  jev_error: [502, "jev_error"],
};

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/api/seefood") return env.ASSETS.fetch(req);

    const started = Date.now();
    const log = {
      event: "seefood",
      country: req.cf?.country,
      colo: req.cf?.colo,
      device: device(req.headers.get("User-Agent")),
    };
    let res;
    try {
      res = req.method === "POST" ? await seefood(req, env, ctx, log) : fail(log, 405, "bad_request");
    } catch (e) {
      log.error = String(e?.stack ?? e);
      res = fail(log, 500, "internal");
    }
    log.status = res.status;
    log.ms = Date.now() - started;
    emit(log);
    track(env, ctx, log);
    return res;
  },
};

async function seefood(req, env, ctx, log) {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  const { success } = await env.LIMITER.limit({ key: ip });
  if (!success) return fail(log, 429, "rate_limited", { "Retry-After": "60" });

  let body;
  try {
    body = await req.json();
  } catch {
    return fail(log, 400, "bad_request");
  }
  const { image, mode } = body ?? {};
  log.mode = mode === "live" ? "live" : "snap";
  if (typeof image !== "string" || image.length > MAX_BASE64 || !BASE64.test(image)) {
    return fail(log, 400, "bad_request");
  }
  log.image_kb = Math.round((image.length * 0.75) / 1024);

  const ref = crypto.randomUUID();
  const jev = await askJev(
    env,
    {
      model: MODEL,
      state: { photo: ref },
      assets: { [ref]: { type: "image", format: "jpg", data_base64: image } },
      questions: QUESTIONS,
    },
    { images: true },
  );
  Object.assign(log, { jev_ms: jev.ms, jev_status: jev.status, jev_request_id: jev.requestId });

  if (!jev.ok) {
    Object.assign(log, { jev_error: jev.kind, jev_error_type: jev.errorType, jev_message: jev.message });
    if (jev.kind === "depleted" || jev.kind === "auth") {
      ctx.waitUntil(monitorOf(env).jevProblem(jev.kind, jev.message ?? jev.errorType).catch(monitorFailed));
    }
    const [status, code] = FAILURES[jev.kind];
    return fail(log, status, code, jev.kind === "busy" ? { "Retry-After": "5" } : undefined);
  }

  const { model, answers, usage } = jev;
  const obscene = answers.obscene.noul;
  const hotdog = answers.hotdog.noul;
  Object.assign(log, {
    model,
    hotdog,
    obscene,
    input_tokens: usage?.input_tokens,
    cost_usd: Number(((usage?.input_tokens ?? 0) * PRICE_PER_TOKEN).toFixed(6)),
  });

  // Flagged photos get no verdict at all, so there's nothing to put on a share card.
  if (obscene >= OBSCENE_AT) {
    log.outcome = "blocked";
    return json({ blocked: true, obscene, model, ms: jev.ms });
  }
  log.outcome = hotdog >= HOTDOG_AT ? "hotdog" : "not_hotdog";
  return json({
    obscene,
    hotdog,
    isHotdog: hotdog >= HOTDOG_AT,
    box: answers.where?.box ?? null,
    boxConfidence: answers.where?.confidence ?? null,
    model,
    ms: jev.ms,
  });
}

function fail(log, status, code, headers) {
  log.outcome = code;
  return json({ error: code }, status, headers);
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

// ------------------------------------------------------------------ logs

// One structured line per API request; Workers Logs indexes every field for querying.
const ERRORS = new Set(["out_of_credits", "unavailable", "jev_error", "internal"]);
const WARNINGS = new Set(["rate_limited", "busy", "timeout", "bad_image", "bad_request"]);

function emit(log) {
  if (ERRORS.has(log.outcome)) return console.error(log);
  if (WARNINGS.has(log.outcome)) return console.warn(log);
  if (log.mode === "live") {
    if (Math.random() >= LIVE_LOG_SAMPLE) return;
    log.sample_rate = LIVE_LOG_SAMPLE;
  }
  console.log(log);
}

function device(ua = "") {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return /Mobi/.test(ua) ? "mobile" : "desktop";
}

// ------------------------------------------------------------------ traffic counts

// Each isolate tallies its own requests and flushes to the Monitor at most every 10 s,
// so a traffic spike doesn't also mean one Durable Object call per photo.
let pending = {};
let lastFlush = 0;

function track(env, ctx, log) {
  const minute = Math.floor(Date.now() / 60_000);
  const b = (pending[minute] ??= { req: 0 });
  b.req++;
  const bump = (k) => (b[k] = (b[k] ?? 0) + 1);
  if (log.outcome === "hotdog") bump("hotdog");
  else if (log.outcome === "blocked") bump("blocked");
  else if (log.outcome === "rate_limited") bump("limited");
  else if (log.status >= 500) bump("errors");
  if (log.input_tokens) b.tokens = (b.tokens ?? 0) + log.input_tokens;

  if (Date.now() - lastFlush < 10_000) return;
  const batch = pending;
  pending = {};
  lastFlush = Date.now();
  ctx.waitUntil(monitorOf(env).record(batch).catch(monitorFailed));
}

const monitorOf = (env) => env.MONITOR.get(env.MONITOR.idFromName("global"));
const monitorFailed = (e) => console.error({ event: "monitor_failed", error: String(e) });
