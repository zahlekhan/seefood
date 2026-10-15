// Send photos through SeeFood's API and print what the obscene-photo filter decides.
//
//   node scripts/check-filter.mjs test-images/
//   node scripts/check-filter.mjs --url https://not-hotdog.theotherkhan271.workers.dev ~/Desktop/test.heic
//
// Takes files or folders of JPEG, PNG or HEIC. macOS `sips` shrinks each one to ≤1024px JPEG
// first, the same as the app does in the browser. The block threshold is OBSCENE_AT in src/worker.js.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

const args = process.argv.slice(2);
let base = "http://localhost:8790";
const at = args.indexOf("--url");
if (at !== -1) base = args.splice(at, 2)[1];
if (!args.length) {
  console.error("usage: node scripts/check-filter.mjs [--url <app url>] <photos or folders>");
  process.exit(1);
}

const IMAGE = /\.(jpe?g|png|heic)$/i;
const files = args.flatMap((a) =>
  statSync(a).isDirectory() ? readdirSync(a).filter((f) => IMAGE.test(f)).sort().map((f) => join(a, f)) : [a],
);
const tmp = mkdtempSync(join(tmpdir(), "seefood-"));

for (const file of files) {
  const jpg = join(tmp, basename(file, extname(file)) + ".jpg");
  execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1024", file, "--out", jpg], { stdio: "ignore" });
  const res = await fetch(`${base}/api/seefood`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: readFileSync(jpg).toString("base64") }),
  });
  const d = await res.json();
  const name = basename(file).padEnd(28);
  if (!res.ok) console.log(`${name} ERROR    ${d.error}`);
  else if (d.blocked) console.log(`${name} BLOCKED  obscene=${d.obscene.toFixed(2)}`);
  else console.log(`${name} allowed  obscene=${d.obscene.toFixed(2)}  hotdog=${d.hotdog.toFixed(2)}`);
}
