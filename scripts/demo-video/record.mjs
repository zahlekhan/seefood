// Record the live SeeFood app in a phone-sized headless Chrome, for the demo video.
//
//   node record.mjs <puppeteer-core dir> <chrome binary> <camera.mjpeg> <out dir> [--live-only]
//
// Taps four sample photos, then turns on Live mode with a fake camera feed (a file Chrome
// plays as the camera). --live-only skips the samples and records one full loop of the feed.
// Every verdict is a real answer from the deployed app and Jev.
// Writes <out>/app-recording.mp4 (30 fps) and <out>/events.json (timestamps of each beat).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [puppeteerDir, chrome, feed, out, flag] = process.argv.slice(2);
const liveOnly = flag === "--live-only";
const puppeteer = createRequire(import.meta.url)(puppeteerDir);
const URL = "https://seefood.si/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${feed}`,
  ],
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
});
// The fake-camera flag counts as "camera already allowed", which makes the app skip its home
// screen. Report "not asked yet" instead, like a first-time visitor.
await page.evaluateOnNewDocument(() => {
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (d) => (d?.name === "camera" ? Promise.resolve({ state: "prompt" }) : query(d));
});
await page.goto(URL, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
await sleep(400);

const frames = [];
const events = [];
const cdp = await page.createCDPSession();
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  frames.push({ data, t: metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
const mark = (name, extra = {}) => events.push({ name, t: Date.now() / 1000, ...extra });
const state = () => page.$eval("#phone", (el) => el.dataset.state);
const waitState = (s) =>
  page.waitForFunction((s) => document.querySelector("#phone").dataset.state === s, { timeout: 30_000, polling: 50 }, s);
const verdict = () =>
  page.$eval("#verdict", (v) => ({
    kind: v.className.replace("pop", "").trim(),
    word: v.querySelector(".word").textContent,
    prob: v.querySelector(".prob").textContent,
  }));

await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 780, maxHeight: 1688 });
await sleep(300);
mark("home");
await sleep(1600);

for (const [sample, hold] of liveOnly ? [] : [
  ["hotdog", 2600],
  ["pizza", 1800],
  ["wiener-dog", 1800],
  ["corndog", 2600],
]) {
  mark("tap", { sample });
  await page.tap(`[data-sample="${sample}"]`);
  await page.waitForFunction(() => ["result", "blocked"].includes(document.querySelector("#phone").dataset.state), {
    timeout: 30_000,
    polling: 50,
  });
  mark("verdict", { sample, ...(await verdict()) });
  await sleep(hold);
  await page.tap("#again");
  await waitState("home");
  mark("home");
  await sleep(450);
}

mark("open-camera");
await page.tap("#open");
await waitState("camera");
await sleep(900);
mark("live");
await page.tap("#live");
// Note each time the live banner changes.
let last = "";
const liveUntil = Date.now() + (liveOnly ? 15_000 : 10_500);
while (Date.now() < liveUntil) {
  const v = await verdict().catch(() => null);
  const key = v && (await page.$eval("#verdict", (el) => !el.hidden)) ? `${v.word}|${v.prob}` : "";
  if (key && key.split("|")[0] !== last.split("|")[0]) mark("live-verdict", v);
  if (key) last = key;
  await sleep(60);
}
mark("end");
await cdp.send("Page.stopScreencast");
console.log("state at end:", await state());
await browser.close();

// Screencast frames arrive only when pixels change; give each one its real on-screen duration.
const dir = join(out, ".frames");
mkdirSync(dir, { recursive: true });
const t0 = frames[0].t;
const end = events.at(-1).t;
let list = "";
frames.forEach((f, i) => {
  const file = join(dir, `${String(i).padStart(5, "0")}.jpg`);
  writeFileSync(file, Buffer.from(f.data, "base64"));
  const next = i + 1 < frames.length ? frames[i + 1].t : end;
  list += `file '${file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
});
list += `file '${join(dir, `${String(frames.length - 1).padStart(5, "0")}.jpg`)}'\n`;
writeFileSync(join(dir, "list.txt"), list);
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
  "-vf", "fps=30,scale=780:1688:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "14", "-preset", "slow",
  "-movflags", "+faststart", join(out, "app-recording.mp4"),
]);
const rel = events.map((e) => ({ ...e, t: Number((e.t - t0).toFixed(3)) }));
writeFileSync(join(out, "events.json"), JSON.stringify(rel, null, 2));
console.log(`${frames.length} frames, ${(end - t0).toFixed(1)}s`);
for (const e of rel) console.log(e.t.toFixed(2).padStart(6), e.name, e.sample ?? "", e.word ?? "", e.prob ?? "");
