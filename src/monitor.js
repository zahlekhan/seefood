// One global Durable Object that totals traffic from every Worker isolate and sends alerts,
// so a spike or an empty Jev account pings the owner once instead of once per request.

import { DurableObject } from "cloudflare:workers";
import { PRICE_PER_TOKEN } from "./jev.js";

const MINUTE = 60_000;
const COOLDOWN = 30 * MINUTE; // don't repeat the same alert more often than this

const PROBLEMS = {
  depleted: "💸 Jev credits are used up. SeeFood is showing users an error until you top up.",
  auth: "🔑 Jev rejected the API key (missing, revoked or wrong). SeeFood is showing users an error.",
};

export class Monitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.minutes = (await ctx.storage.get("minutes")) ?? {}; // minute -> counts
      this.alerts = (await ctx.storage.get("alerts")) ?? {}; // kind -> { at, level }
    });
  }

  /** Counts flushed by Worker isolates, keyed by epoch minute. */
  async record(batch) {
    for (const [minute, counts] of Object.entries(batch)) {
      const b = (this.minutes[minute] ??= {});
      for (const [k, v] of Object.entries(counts)) b[k] = (b[k] ?? 0) + v;
    }
    const now = Math.floor(Date.now() / MINUTE);
    for (const minute of Object.keys(this.minutes)) if (minute < now - 120) delete this.minutes[minute];
    await this.ctx.storage.put("minutes", this.minutes);
    await this.checkSpike(now);
  }

  /** depleted | auth, seen by a user request. Alerts at once. */
  async jevProblem(kind, detail) {
    await this.alertOnce(kind, `${PROBLEMS[kind]}\nJev said: ${detail ?? "(no message)"}`);
  }

  status() {
    const now = Math.floor(Date.now() / MINUTE);
    return { last5min: this.sum(now, 5), last60min: this.sum(now, 60), alerts: this.alerts };
  }

  // ------------------------------------------------------------------ internals

  async checkSpike(now) {
    const limit = Number(this.env.SPIKE_REQUESTS_5MIN) || 2000;
    const w = this.sum(now, 5);
    if (w.req < limit) return;
    const last = this.alerts.spike;
    // Once per cooldown, or again if traffic has doubled since the last spike alert.
    if (last && Date.now() - last.at < COOLDOWN && w.req < last.level * 2) return;
    const costPerHour = (w.tokens ?? 0) * 12 * PRICE_PER_TOKEN;
    await this.send(
      "spike",
      `📈 Traffic spike: ${w.req} requests in the last 5 min (~${w.req * 12}/hour, ~$${costPerHour.toFixed(2)}/hour of Jev credit).\n` +
        `${w.hotdog ?? 0} hotdogs, ${w.blocked ?? 0} blocked as obscene, ${w.limited ?? 0} rate-limited, ${w.errors ?? 0} errors.`,
      w.req,
    );
  }

  sum(now, minutes) {
    const total = { req: 0 };
    for (let m = now - minutes + 1; m <= now; m++) {
      for (const [k, v] of Object.entries(this.minutes[m] ?? {})) total[k] = (total[k] ?? 0) + v;
    }
    return total;
  }

  async alertOnce(kind, text) {
    const last = this.alerts[kind];
    if (last && Date.now() - last.at < COOLDOWN) return;
    await this.send(kind, text);
  }

  async send(kind, text, level = 0) {
    this.alerts[kind] = { at: Date.now(), level };
    await this.ctx.storage.put("alerts", this.alerts);
    console.warn({ event: "alert", kind, text, delivered: Boolean(this.env.ALERT_WEBHOOK) });
    if (!this.env.ALERT_WEBHOOK) return;
    try {
      await postAlert(this.env.ALERT_WEBHOOK, kind, text);
    } catch (e) {
      console.error({ event: "alert_failed", kind, error: String(e) });
    }
  }
}

// Discord, Slack and ntfy each want a different body; anything else gets plain JSON.
async function postAlert(url, kind, text) {
  const host = new URL(url).hostname;
  const message = `SeeFood: ${text}`;
  let init;
  if (host.endsWith("discord.com") || host.endsWith("discordapp.com")) {
    init = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: message }) };
  } else if (host === "hooks.slack.com") {
    init = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: message }) };
  } else if (host.includes("ntfy")) {
    const urgent = kind === "depleted" || kind === "auth";
    init = { headers: { Title: `SeeFood: ${kind}`, Priority: urgent ? "high" : "default", Tags: "hotdog" }, body: text };
  } else {
    init = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "seefood", kind, text }) };
  }
  const res = await fetch(url, { method: "POST", ...init });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
}
