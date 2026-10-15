// SeeFood API: one photo in, one Jev 1.14 call out. The key never leaves the Worker.

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.14.0"; // Box questions need 1.14

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

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/seefood") {
      return req.method === "POST" ? seefood(req, env) : json({ error: "POST a photo." }, 405);
    }
    return env.ASSETS.fetch(req);
  },
};

async function seefood(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  const { success } = await env.LIMITER.limit({ key: ip });
  if (!success) return json({ error: "Too many photos. Jian-Yang needs a minute." }, 429);

  let image;
  try {
    ({ image } = await req.json());
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  if (typeof image !== "string" || image.length > MAX_BASE64 || !BASE64.test(image)) {
    return json({ error: "Send a base64 JPEG." }, 400);
  }

  const ref = crypto.randomUUID();
  const started = Date.now();
  let res;
  try {
    res = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        state: { photo: ref },
        assets: { [ref]: { type: "image", format: "jpg", data_base64: image } },
        questions: QUESTIONS,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return json({ error: "Jev didn't answer in time." }, 504);
  }
  const ms = Date.now() - started;

  if (!res.ok) {
    console.log("jev error", res.status, (await res.text()).slice(0, 500));
    if (res.status === 429) return json({ error: "Jev is swamped. Try again in a sec." }, 429);
    return json({ error: "Jev couldn't read that photo." }, 502);
  }

  const { model, answers } = await res.json();
  const obscene = answers.obscene.noul;
  // Flagged photos get no verdict at all, so there's nothing to put on a share card.
  if (obscene >= OBSCENE_AT) return json({ blocked: true, obscene, model, ms });
  const p = answers.hotdog.noul;
  return json({
    obscene,
    hotdog: p,
    isHotdog: p >= HOTDOG_AT,
    box: answers.where?.box ?? null,
    boxConfidence: answers.where?.confidence ?? null,
    model,
    ms,
  });
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
