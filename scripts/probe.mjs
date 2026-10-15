// Send each test image straight to Jev: one Noul (hotdog?) + one Box (where?).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const key = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/TYPESAFE_API_KEY=(\S+)/)[1];

for (const f of readdirSync(dir).filter((f) => f.endsWith(".jpg"))) {
  const ref = crypto.randomUUID();
  const t = Date.now();
  const r = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "TypeSafe-Danger-Zone-Images": "true" },
    body: JSON.stringify({
      model: "jev-1.14.0",
      state: { photo: ref },
      assets: { [ref]: { type: "image", format: "jpg", data_base64: readFileSync(join(dir, f)).toString("base64") } },
      questions: {
        hotdog: { type: "noul", instructions: "Is `photo` a picture of a hot dog?" },
        where: { type: "box", instructions: "the hot dog in `photo`" },
      },
    }),
  });
  const body = await r.text();
  console.log(f, r.status, `${Date.now() - t}ms`, body.slice(0, 400));
}
