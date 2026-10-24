// Render the app's verdict sounds (public/app.js chime()) to WAV for the demo video:
// hotdog = two bright triangle notes, not hotdog = two low square notes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RATE = 44100;
const out = process.argv[2];
mkdirSync(out, { recursive: true });

function render(notes, wave, peak, length) {
  const n = Math.round(length * RATE);
  const buf = new Float32Array(n);
  for (const [freq, start] of notes) {
    for (let i = Math.round(start * RATE); i < n; i++) {
      const t = i / RATE - start;
      if (t > 0.26) break;
      // exponential attack to `peak` in 10 ms, exponential decay to silence by 240 ms (same as the app)
      const env = t < 0.01 ? 0.0001 * Math.pow(peak / 0.0001, t / 0.01) : peak * Math.pow(0.0001 / peak, (t - 0.01) / 0.23);
      const phase = (t * freq) % 1;
      const s = wave === "triangle" ? 1 - 4 * Math.abs(phase - 0.5) : phase < 0.5 ? 1 : -1;
      buf[i] += s * env;
    }
  }
  return buf;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

writeFileSync(join(out, "hotdog.wav"), wav(render([[880, 0], [1318.5, 0.09]], "triangle", 0.55, 0.4)));
writeFileSync(join(out, "not-hotdog.wav"), wav(render([[220, 0], [146.8, 0.13]], "square", 0.22, 0.45)));
console.log("wrote", out);
