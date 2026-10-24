// SeeFood: hotdog or not hotdog, on Jev 1.14.

const $ = (s) => document.querySelector(s);
const phone = $("#phone"), stage = $("#stage"), video = $("#video"), photo = $("#photo"), backdrop = $("#backdrop");
const boxEl = $("#box"), scanEl = $("#scan"), verdictEl = $("#verdict"), homeEl = $("#home");
const livePill = $("#livepill"), toastEl = $("#toast"), fileInput = $("#file"), oops = $("#oops");

const GREEN = "#36c24a", RED = "#e8423f";
const MIN_SIDE = 280, MAX_SIDE = 1568; // Jev image limits: ≥78,400 px and 256–1568 px per side
const VIEW_SIDE = 1280; // what we show and put on the share card
const SNAP_SIDE = 1024, LIVE_SIDE = 640; // what we send to Jev
const LIVE_EVERY = 400; // ms between live frames; keep under the Worker's per-IP limit
const LIVE_ON = 0.6, LIVE_OFF = 0.4; // hysteresis, so the live banner doesn't flicker

let state = "home";
let stream = null;
let live = false;
let liveRun = 0;
let shown = null; // { view, result, box } currently on screen
let cardFile = null; // pre-rendered share card, so navigator.share runs inside the tap

// ---------------------------------------------------------------- state

function setState(s) {
  state = phone.dataset.state = s;
  for (const b of document.querySelectorAll("#controls [data-in]")) b.hidden = !b.dataset.in.split(" ").includes(s);
  homeEl.hidden = s !== "home";
  livePill.hidden = s !== "live";
}

function showMedia(which) {
  video.hidden = which !== "video";
  photo.hidden = backdrop.hidden = which !== "photo";
}

// Photos are shown whole (contain) over a blurred copy of themselves.
function setPhoto(view) {
  photo.src = backdrop.src = view.toDataURL("image/jpeg", 0.92);
  return photo.decode();
}

function clearVerdict() {
  verdictEl.hidden = boxEl.hidden = true;
  stage.classList.remove("censored");
  shown = null;
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (p) => `${Math.round(p * 100)}%`;

// ---------------------------------------------------------------- errors

const UA = navigator.userAgent;
const iOS = /iP(hone|ad|od)/.test(UA) || (navigator.maxTouchPoints > 1 && /Mac/.test(UA));
const CAMERA_HELP = iOS
  ? "On iPhone: Settings → Apps → Safari → Camera → Allow, then reload."
  : /Android/.test(UA)
    ? "Tap the icon left of the address bar, then Permissions → Camera → Allow."
    : "Click the camera icon in the address bar to allow it, then reload.";

// Every failure a user can hit, in their words. Codes come from the API (src/worker.js) or the browser.
const ERRORS = {
  out_of_credits: { icon: "💸", title: "SeeFood is out of hotdog money", text: "The app has used up its Jev credits. It's not you. Check back a little later." },
  unavailable: { icon: "🔧", title: "SeeFood is down for a bit", text: "It's not you, it's us. Check back a little later." },
  busy: { icon: "🌭", title: "Jev is swamped", text: "Lots of people are checking hotdogs right now. Try again in a few seconds.", retry: true },
  timeout: { icon: "⏳", title: "Jev took too long", text: "That one timed out. Try again.", retry: true },
  jev_error: { icon: "🤕", title: "Jev hit a snag", text: "Something went wrong on Jev's side. Try again in a moment.", retry: true },
  internal: { icon: "🤕", title: "Something broke", text: "That's on us. Try again.", retry: true },
  rate_limited: { icon: "🐢", title: "Easy there", text: "That's a lot of photos in one minute. Wait a minute, then try again.", retry: true },
  offline: { icon: "📡", title: "You're offline", text: "SeeFood needs the internet to ask Jev. Reconnect and try again.", retry: true },
  network: { icon: "📡", title: "Couldn't reach SeeFood", text: "Check your connection and try again.", retry: true },
  bad_image: { icon: "🖼️", title: "Couldn't read that photo", text: "Try a different photo. A normal photo from your camera roll works best." },
  bad_request: { icon: "🖼️", title: "Couldn't send that photo", text: "Try a different photo." },
  not_image: { icon: "🖼️", title: "That's not a photo", text: "Pick an image, like a photo from your camera roll." },
  camera_denied: { icon: "📷", title: "Camera is blocked", text: `${CAMERA_HELP} Or tap a sample, or upload a photo.` },
  camera_missing: { icon: "📷", title: "No camera found", text: "Upload a photo or tap a sample instead." },
  camera_busy: { icon: "📷", title: "Camera is busy", text: "Another app is using the camera. Close it and try again.", retry: true },
  camera_unsupported: { icon: "📷", title: "Camera doesn't work here", text: "This browser can't open the camera. Upload a photo or tap a sample instead." },
};

class AppError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

let retryFn = null;
function showError(code, retry) {
  const e = ERRORS[code] ?? ERRORS.internal;
  oops.querySelector(".emoji").textContent = e.icon;
  oops.querySelector("h2").textContent = e.title;
  oops.querySelector("p").textContent = e.text;
  retryFn = e.retry && retry ? retry : null;
  $("#oops-retry").hidden = !retryFn;
  $("#oops-close").textContent = retryFn ? "Cancel" : "OK";
  $("#oops-close").classList.toggle("primary", !retryFn);
  oops.hidden = false;
}

function hideError() {
  oops.hidden = true;
  retryFn = null;
}

// ---------------------------------------------------------------- images

// Scale `src` so its longest side is ≤ maxSide, upscaling if the short side would fall
// under minSide, and centre it on a canvas at least minSide on each side.
function fit(src, w, h, maxSide, minSide = 0) {
  let s = Math.min(1, maxSide / Math.max(w, h));
  if (Math.min(w, h) * s < minSide) s = Math.min(MAX_SIDE / Math.max(w, h), minSide / Math.min(w, h));
  const dw = Math.round(w * s), dh = Math.round(h * s);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(dw, minSide);
  canvas.height = Math.max(dh, minSide);
  const x = (canvas.width - dw) / 2, y = (canvas.height - dh) / 2;
  const g = canvas.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(src, x, y, dw, dh);
  return { canvas, x, y, w: dw, h: dh };
}

// Jev answers in fractions of the image it was sent; convert to fractions of the unpadded view.
function unpad(b, sent) {
  if (!b) return null;
  const { canvas: c } = sent;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const fx = (v) => clamp((v * c.width - sent.x) / sent.w);
  const fy = (v) => clamp((v * c.height - sent.y) / sent.h);
  return { left: fx(b.left), right: fx(b.right), top: fy(b.top), bottom: fy(b.bottom) };
}

const base64 = (canvas, q) => canvas.toDataURL("image/jpeg", q).split(",")[1];

async function ask(image, mode) {
  if (!navigator.onLine) throw new AppError("offline");
  let r;
  try {
    r = await fetch("/api/seefood", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, mode }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    throw new AppError(e?.name === "TimeoutError" ? "timeout" : navigator.onLine ? "network" : "offline");
  }
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new AppError(d?.error ?? (r.status === 429 ? "rate_limited" : "internal"));
  return d;
}

// ---------------------------------------------------------------- verdict

function setBanner(kind, word, prob, fx) {
  verdictEl.className = kind;
  verdictEl.querySelector(".word").textContent = word;
  verdictEl.querySelector(".prob").textContent = prob;
  verdictEl.hidden = false;
  if (fx) {
    void verdictEl.offsetWidth; // restart the pop animation
    verdictEl.classList.add("pop");
    chime(kind === "yes");
  }
}

function showBlocked(fx) {
  setBanner("blocked", "Not allowed", "Jev flagged this photo. Food only, please.", fx);
  boxEl.hidden = true;
}

function showVerdict(result, box, fx) {
  const yes = result.isHotdog;
  setBanner(yes ? "yes" : "no", yes ? "Hotdog!" : "Not hotdog!", `Jev: ${pct(result.hotdog)} hotdog · ${result.ms} ms`, fx);
  boxEl.hidden = !(yes && box);
  if (!boxEl.hidden) {
    boxEl.querySelector("span").textContent = `🌭 ${pct(result.hotdog)}`;
    placeBox(box);
  }
}

// Map box fractions through the media's object-fit: cover for the camera, contain for photos.
function placeBox(b) {
  const media = video.hidden ? photo : video;
  const iw = media.naturalWidth || media.videoWidth, ih = media.naturalHeight || media.videoHeight;
  if (!iw || !ih) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  const s = (media === photo ? Math.min : Math.max)(W / iw, H / ih);
  const ox = (W - iw * s) / 2, oy = (H - ih * s) / 2;
  Object.assign(boxEl.style, {
    left: `${ox + b.left * iw * s}px`,
    top: `${oy + b.top * ih * s}px`,
    width: `${(b.right - b.left) * iw * s}px`,
    height: `${(b.bottom - b.top) * ih * s}px`,
  });
}

let audio;
function unlockAudio() {
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
}

function chime(yes) {
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(yes ? [40, 60, 40] : 180);
  if (!audio) return;
  const notes = yes ? [[880, 0], [1318.5, 0.09]] : [[220, 0], [146.8, 0.13]];
  for (const [freq, t] of notes) {
    const osc = audio.createOscillator(), gain = audio.createGain();
    const at = audio.currentTime + t;
    osc.type = yes ? "triangle" : "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(yes ? 0.3 : 0.1, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.26);
  }
}

// ---------------------------------------------------------------- flows

async function openCamera() {
  // iOS ends the stream when the app is backgrounded; start a fresh one.
  if (stream?.getVideoTracks().every((t) => t.readyState === "ended")) stream = null;
  if (!navigator.mediaDevices?.getUserMedia) return showError("camera_unsupported");
  try {
    stream ??= await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
  } catch (e) {
    const code = {
      NotAllowedError: "camera_denied",
      SecurityError: "camera_denied",
      NotFoundError: "camera_missing",
      OverconstrainedError: "camera_missing",
      NotReadableError: "camera_busy",
      AbortError: "camera_busy",
    }[e?.name];
    showError(code ?? "camera_unsupported", openCamera);
    return;
  }
  video.srcObject = stream;
  await video.play();
  clearVerdict();
  showMedia("video");
  setState("camera");
}

function grabFrame() {
  return fit(video, video.videoWidth, video.videoHeight, VIEW_SIDE).canvas;
}

async function judge(view) {
  if (state === "busy") return;
  stopLive();
  clearVerdict();
  await setPhoto(view);
  showMedia("photo");
  setState("busy");
  scanEl.hidden = false;
  try {
    const sent = fit(view, view.width, view.height, SNAP_SIDE, MIN_SIDE);
    // Jev answers in ~400 ms; hold the scan a beat so the reveal lands.
    const [result] = await Promise.all([ask(base64(sent.canvas, 0.85), "snap"), sleep(650)]);
    if (result.blocked) {
      showMedia(null); // never un-blur a flagged photo
      setState("blocked");
      showBlocked(true);
    } else {
      showResult({ view, result, box: unpad(result.box, sent) });
    }
  } catch (e) {
    showError(e.code ?? "internal", () => judge(view));
    if (stream) {
      showMedia("video");
      setState("camera");
    } else {
      showMedia(null);
      setState("home");
    }
  } finally {
    scanEl.hidden = true;
  }
}

function showResult(shot) {
  shown = shot;
  showMedia("photo");
  setState("result");
  // Snaps already set the photo; live freezes still need it.
  (shot.fromLive ? setPhoto(shot.view) : Promise.resolve()).then(() => showVerdict(shot.result, shot.box, !shot.fromLive));
  cardFile = renderCard(shot);
}

async function fromFile(file) {
  if (file?.type && !file.type.startsWith("image/")) return showError("not_image");
  // An <img> applies the phone's EXIF rotation everywhere; createImageBitmap doesn't on older Safari.
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
  } catch {
    return showError("bad_image");
  } finally {
    URL.revokeObjectURL(img.src);
  }
  await judge(fit(img, img.naturalWidth, img.naturalHeight, VIEW_SIDE).canvas);
}

// ---------------------------------------------------------------- live

async function startLive() {
  const run = ++liveRun; // a stale loop waking from sleep must not keep going
  live = true;
  let yes = false, kind = null;
  clearVerdict();
  setState("live");
  livePill.textContent = "LIVE · point at food";
  while (live && run === liveRun) {
    const t0 = performance.now();
    const view = grabFrame();
    const sent = fit(view, view.width, view.height, LIVE_SIDE, MIN_SIDE);
    let result;
    try {
      result = await ask(base64(sent.canvas, 0.7), "live");
    } catch (e) {
      if (!live || run !== liveRun) break;
      stopLive();
      showError(e.code ?? "internal", startLive);
      break;
    }
    if (!live || run !== liveRun) break;
    stage.classList.toggle("censored", !!result.blocked);
    if (result.blocked) {
      showBlocked(kind !== "blocked");
      kind = "blocked";
      shown = null; // nothing to freeze or share
    } else {
      yes = yes ? result.hotdog >= LIVE_OFF : result.hotdog >= LIVE_ON;
      const box = unpad(result.box, sent);
      showVerdict({ ...result, isHotdog: yes }, box, kind !== (yes ? "yes" : "no"));
      kind = yes ? "yes" : "no";
      shown = { view, result: { ...result, isHotdog: yes }, box, fromLive: true };
    }
    livePill.textContent = `LIVE · ${result.ms} ms`;
    await sleep(Math.max(0, LIVE_EVERY - (performance.now() - t0)));
  }
}

function stopLive() {
  if (!live) return;
  live = false;
  if (state === "live") {
    clearVerdict();
    setState("camera");
  }
}

// ---------------------------------------------------------------- share

function renderCard({ view, result, box }) {
  const W = 1080, H = 1350, yes = result.isHotdog, color = yes ? GREEN : RED;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const font = (w, px) => `${w} ${px}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;

  // Backdrop: the photo shrunk to a few pixels and scaled back up, which blurs it on every browser.
  const cover = Math.max(W / view.width, H / view.height);
  const tiny = fit(view, view.width, view.height, 24).canvas;
  g.imageSmoothingQuality = "high";
  g.drawImage(tiny, (W - view.width * cover) / 2, (H - view.height * cover) / 2, view.width * cover, view.height * cover);
  g.fillStyle = "rgba(0,0,0,.45)";
  g.fillRect(0, 0, W, H);
  const s = Math.min(W / view.width, H / view.height);
  const ox = (W - view.width * s) / 2, oy = (H - view.height * s) / 2;
  g.drawImage(view, ox, oy, view.width * s, view.height * s);

  if (yes && box) {
    const x = ox + box.left * view.width * s, y = oy + box.top * view.height * s;
    const w = (box.right - box.left) * view.width * s, h = (box.bottom - box.top) * view.height * s;
    g.save();
    g.shadowColor = "rgba(54,194,74,.9)";
    g.shadowBlur = 30;
    g.strokeStyle = GREEN;
    g.lineWidth = 10;
    g.beginPath();
    g.roundRect(x, y, w, h, 28);
    g.stroke();
    g.restore();
  }

  const shade = g.createLinearGradient(0, H - 330, 0, H);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,.88)");
  g.fillStyle = shade;
  g.fillRect(0, H - 330, W, 330);

  g.fillStyle = color;
  g.shadowColor = "rgba(0,0,0,.35)";
  g.shadowBlur = 30;
  g.fillRect(0, 0, W, 250);
  g.shadowBlur = 0;
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = font(900, 116);
  g.fillText(yes ? "Hotdog!" : "Not hotdog!", W / 2, 108);

  const cx = W / 2, cy = 250;
  g.beginPath();
  g.arc(cx, cy, 80, 0, Math.PI * 2);
  g.fillStyle = color;
  g.shadowColor = "rgba(0,0,0,.4)";
  g.shadowBlur = 36;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 12;
  g.strokeStyle = "#fff";
  g.stroke();
  g.lineWidth = 15;
  g.lineCap = g.lineJoin = "round";
  g.beginPath();
  if (yes) {
    g.moveTo(cx - 36, cy + 4);
    g.lineTo(cx - 10, cy + 30);
    g.lineTo(cx + 38, cy - 24);
  } else {
    g.moveTo(cx - 28, cy - 28);
    g.lineTo(cx + 28, cy + 28);
    g.moveTo(cx + 28, cy - 28);
    g.lineTo(cx - 28, cy + 28);
  }
  g.stroke();

  g.fillStyle = "#fff";
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.font = font(800, 54);
  g.fillText(`Jev: ${pct(result.hotdog)} hotdog`, 60, H - 150);
  g.font = font(600, 34);
  g.fillStyle = "rgba(255,255,255,.75)";
  g.fillText(`SeeFood · ${result.ms} ms on Jev 1.14 by @typesafeai`, 60, H - 92);
  g.fillText(location.host, 60, H - 46);

  return new Promise((r) => c.toBlob(r, "image/png")).then(
    (blob) => new File([blob], yes ? "hotdog.png" : "not-hotdog.png", { type: "image/png" }),
  );
}

function shareText({ isHotdog, hotdog }) {
  const verdict = isHotdog ? `Hotdog! 🌭✅ Jev is ${pct(hotdog)} sure.` : `Not hotdog. 🌭❌ (Jev: ${pct(hotdog)} hotdog)`;
  return `${verdict}\n\nSeeFood, the Shazam for food, rebuilt on @typesafeai Jev 1.14 👁️\n${location.origin}`;
}

async function share() {
  if (!shown) return;
  const file = await cardFile;
  const text = shareText(shown.result);
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
    } catch {} // cancelled
    return;
  }
  // Desktop: save the card and open the X composer next to it.
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  toast("Card saved. Drop it into your post.");
}

// ---------------------------------------------------------------- wiring

const on = (id, fn) => $(id).addEventListener("click", (e) => (unlockAudio(), fn(e)));
on("#open", openCamera);
on("#upload", () => fileInput.click());
on("#gallery", () => fileInput.click());
on("#shutter", () => {
  if (state === "camera") return judge(grabFrame());
  if (state !== "live") return;
  if (!shown) return toast("Point it at some food first.");
  live = false; // freeze exactly what Jev just judged
  showResult(shown);
});
on("#live", () => (state === "live" ? stopLive() : startLive()));
on("#again", () => {
  clearVerdict();
  if (stream) {
    showMedia("video");
    setState("camera");
  } else {
    showMedia(null);
    setState("home");
  }
});
on("#share", share);
$("#samples").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sample]");
  if (!b) return;
  unlockAudio();
  let blob;
  try {
    blob = await fetch(`/samples/${b.dataset.sample}.jpg`).then((r) => (r.ok ? r.blob() : Promise.reject()));
  } catch {
    return showError(navigator.onLine ? "network" : "offline", () => b.click());
  }
  await fromFile(blob);
});
on("#oops-retry", () => {
  const retry = retryFn;
  hideError();
  retry?.();
});
on("#oops-close", hideError);

fileInput.addEventListener("change", () => {
  const [f] = fileInput.files;
  fileInput.value = "";
  if (f) fromFile(f);
});

const firstImage = (list) => [...(list ?? [])].find((f) => f.type.startsWith("image/"));
addEventListener("paste", (e) => {
  const f = firstImage(e.clipboardData?.files);
  if (f) fromFile(f);
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  const f = firstImage(e.dataTransfer?.files);
  if (f) fromFile(f);
});

addEventListener("resize", () => !boxEl.hidden && shown?.box && placeBox(shown.box));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLive();
  else if (state === "camera") openCamera();
});

setState("home");

// Installed or already allowed? Skip the home screen and go straight to the camera.
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
$("#install").hidden = !(iOS && !standalone);
navigator.permissions
  ?.query({ name: "camera" })
  .then((p) => p.state === "granted" && state === "home" && openCamera())
  .catch(() => {});
