/**
 * Optional push: POST every matching human event to a webhook the moment it is written.
 * Off unless FRAMEBACK_WEBHOOK_URL is set (or `frameback open --webhook <url>`).
 *   FRAMEBACK_WEBHOOK_URL     target URL
 *   FRAMEBACK_WEBHOOK_SECRET  optional; signs the body (X-Webhook-Signature-V2 = hex HMAC-SHA256 of "<ts>.<body>")
 *   FRAMEBACK_WEBHOOK_EVENTS  comma-separated event types (default: review.submitted,thread.message)
 *   FRAMEBACK_WEBHOOK_ROOT    optional; reviewDir is sent relative to this folder (e.g. /videos) instead of "review/<stem>"
 * Only events written by the human are pushed, so an agent never triggers itself.
 */
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import type { Event } from "./schema.js";

const DEFAULT_EVENTS = "review.submitted,thread.message";

/**
 * Validate FRAMEBACK_WEBHOOK_URL once at startup. Returns the origin to announce (never the path or the secret),
 * or undefined when the webhook is off. Throws on an unusable URL so a typo does not silently disable the push.
 */
export function checkWebhookConfig(): string | undefined {
  const raw = process.env.FRAMEBACK_WEBHOOK_URL;
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`FRAMEBACK_WEBHOOK_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`FRAMEBACK_WEBHOOK_URL must be http(s), got ${url.protocol}`);
  }
  return url.origin;
}

/**
 * Never send an absolute path. Default: "review/<stem>" (relative to the video's folder). With FRAMEBACK_WEBHOOK_ROOT
 * set (e.g. /videos in compose) and the review folder inside it: the path below that root, e.g. "client-a/review/final_v1".
 */
export function relativeReviewDir(reviewDir: string): string {
  const root = process.env.FRAMEBACK_WEBHOOK_ROOT;
  if (root) {
    const rel = path.relative(path.resolve(root), path.resolve(reviewDir));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return `review/${path.basename(reviewDir)}`;
}

export function fireWebhook(ev: Event, reviewDir: string): void {
  const url = process.env.FRAMEBACK_WEBHOOK_URL;
  if (!url || ev.actor !== "human") return;
  const wanted = (process.env.FRAMEBACK_WEBHOOK_EVENTS || DEFAULT_EVENTS).split(",").map((s) => s.trim());
  if (!wanted.includes(ev.type)) return;
  const body = JSON.stringify({
    event_type: ev.type,
    review: ev.review,
    commentId: ev.commentId ?? null,
    seq: ev.seq,
    actor: ev.actor,
    reviewDir: relativeReviewDir(reviewDir),
    data: ev.data ?? {},
  });
  const headers: Record<string, string> = { "content-type": "application/json", "x-request-id": randomUUID() };
  const secret = process.env.FRAMEBACK_WEBHOOK_SECRET;
  if (secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-webhook-timestamp"] = ts;
    headers["x-webhook-signature-v2"] = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  }
  void (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000), redirect: "error" });
        if (res.ok) return;
        console.error(`frameback: webhook ${ev.type} -> HTTP ${res.status}`);
      } catch (e) {
        console.error(`frameback: webhook ${ev.type} failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  })();
}
