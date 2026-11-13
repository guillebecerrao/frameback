/** `frameback open` — start the review server for a video, or attach to one that is already running. */
import { checkWebhookConfig } from "../core/webhook.js";
import path from "node:path";
import open from "open";
import type { Health, RegisterReviewRequest, RegisterReviewResponse } from "../core/index.js";
import { DEV_UI_PORT } from "../server/app.js";
import { assertVideoFile, startServer } from "../server/index.js";
import { shareWarning, DEFAULT_SHARE_TTL_HOURS, type ShareLink, type ShareMode } from "../server/share.js";

export interface OpenCommandOptions {
  port: number;
  open: boolean;
  edl?: string;
  timeline?: string;
  carry: boolean;
  force?: boolean;
  dev?: boolean;
  /** let another computer review with a key in the link: all private networks, or Tailscale only */
  share?: ShareMode;
  /** hours the share key stays valid */
  shareTtl?: number;
  webhook?: string;
}

/** How many consecutive ports to try after the requested one. */
const PORT_SPAN = 10;
/** Retries on one port when another `frameback open` wins the race for it. */
const BIND_RETRIES = 4;
const HOST = "127.0.0.1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Probe = "frameback" | "other" | "none";

async function probePort(port: number): Promise<Probe> {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const health = (await res.json().catch(() => null)) as Partial<Health> | null;
    return health?.app === "frameback" ? "frameback" : "other";
  } catch {
    return "none";
  }
}

async function registerRemote(port: number, req: RegisterReviewRequest): Promise<RegisterReviewResponse> {
  const res = await fetch(`http://${HOST}:${port}/api/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = (await res.json().catch(() => null)) as (RegisterReviewResponse & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `server on port ${port} answered ${res.status}`);
  return body;
}

interface RemoteShare {
  links: ShareLink[];
  mode: ShareMode;
  expiresAt: string;
}

/** Ask a running `--share` server (trusted local clients only) for the links to give the other computer. */
async function remoteShare(port: number, rid: string): Promise<RemoteShare> {
  const res = await fetch(`http://${HOST}:${port}/api/share?rid=${encodeURIComponent(rid)}`, { signal: AbortSignal.timeout(2000) });
  const body = (await res.json().catch(() => null)) as Partial<RemoteShare> | null;
  if (!res.ok || !body?.links || !body.mode || !body.expiresAt) throw new Error(`server on port ${port} did not return share links (${res.status})`);
  return body as RemoteShare;
}

const LABEL: Record<ShareLink["kind"], string> = {
  tailscale: "Tailscale · encrypted",
  lan: "local network · trusted networks only (home/office)",
};

const IP_HOST = /^http:\/\/\d{1,3}(\.\d{1,3}){3}:/;

/** The one link to hand over: a Tailscale IP (no DNS needed), else a LAN IP, else whatever is first. */
export function pickRecommended(links: ShareLink[]): ShareLink {
  const byIp = (kind: ShareLink["kind"]) => links.find((l) => l.kind === kind && IP_HOST.test(l.url));
  return byIp("tailscale") ?? byIp("lan") ?? links[0];
}

export function formatShare(links: ShareLink[]): string[] {
  if (links.length === 0) return ["No private network found to share on (connect to a wifi or start Tailscale, then run again)."];
  const main = pickRecommended(links);
  const others = links.filter((l) => l !== main);
  const out = ["", "To review from another computer, open this link there:", `  ${main.url}    [${LABEL[main.kind]}]`];
  if (others.length) {
    out.push("", "Other addresses for the same review (use them only if the one above does not open):");
    for (const l of others) out.push(`  ${l.url}    [${LABEL[l.kind]}]`);
  }
  return out;
}

function printShare(links: ShareLink[]): void {
  for (const line of formatShare(links)) console.log(line);
}

function announce(port: number, rid: string, reviewDir: string, shared = false): void {
  console.log(`${shared ? "Frameback (this Mac only, no key)" : "Frameback"}: http://${HOST}:${port}/?r=${encodeURIComponent(rid)}`);
  console.log(`Review dir: ${reviewDir}`);
}

function report(carried: number | undefined, warnings: string[] | undefined): void {
  if (carried) console.error(`frameback: carried ${carried} comment(s) from the previous version for verification`);
  for (const warning of warnings ?? []) console.error(`frameback: warning: ${warning}`);
}

async function openBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch (e) {
    console.error(`frameback: could not open a browser (${(e as Error).message}); open the URL above manually`);
  }
}

export async function openCommand(videoArg: string, opts: OpenCommandOptions): Promise<void> {
  if (opts.webhook) process.env.FRAMEBACK_WEBHOOK_URL = opts.webhook;
  const webhookOrigin = checkWebhookConfig();
  const video = await assertVideoFile(videoArg);
  const request: RegisterReviewRequest = {
    video,
    edl: opts.edl ? path.resolve(opts.edl) : undefined,
    timeline: opts.timeline ? path.resolve(opts.timeline) : undefined,
    carry: opts.carry,
    force: opts.force,
  };

  for (let port = opts.port; port <= opts.port + PORT_SPAN; port++) {
    for (let attempt = 0; attempt < BIND_RETRIES; attempt++) {
      const found = await probePort(port);
      if (found === "other") break; // not ours: next port
      if (found === "frameback") {
        if (opts.webhook) {
          console.error(
            `frameback: --webhook ignored: a Frameback server is already running on port ${port} and it is the one that writes the events. Set FRAMEBACK_WEBHOOK_URL when you start that server.`,
          );
        }
        const health = opts.share
          ? ((await (await fetch(`http://${HOST}:${port}/api/health`)).json().catch(() => null)) as Partial<Health> | null)
          : null;
        if (opts.share) {
          if (!health?.share) {
            throw new Error(
              `a Frameback server is already running on port ${port} without --share. Stop it (Ctrl+C in its terminal, or kill pid ${health?.pid ?? "?"}) and run this command again with --share`,
            );
          }
        }
        let shared: RemoteShare | undefined;
        if (opts.share) {
          shared = await remoteShare(port, "");
          if (shared.mode !== opts.share || Date.parse(shared.expiresAt) <= Date.now()) {
            throw new Error(
              `the Frameback server on port ${port} ${shared.mode !== opts.share ? `shares on ${shared.mode === "tailscale" ? "Tailscale only" : "all private networks"}` : "has an expired share link"}. Stop it (Ctrl+C in its terminal, or kill pid ${health?.pid ?? "?"}) and run this command again`,
            );
          }
        }
        const summary = await registerRemote(port, request);
        announce(port, summary.rid, summary.reviewDir, !!opts.share);
        report(summary.carried, summary.warnings);
        if (opts.share) printShare((await remoteShare(port, summary.rid)).links);
        if (opts.open) await openBrowser(`http://${HOST}:${port}/?r=${encodeURIComponent(summary.rid)}`);
        return;
      }

      let server;
      try {
        server = await startServer({ port, serveWeb: !opts.dev, dev: opts.dev, share: opts.share, shareTtlHours: opts.shareTtl });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
          // another `frameback open` may have just claimed this port: look at it again before moving on
          await sleep(150 + Math.random() * 150);
          continue;
        }
        throw e;
      }
      let result;
      try {
        result = await server.registry.register(video, { edlPath: request.edl, timelinePath: request.timeline, carry: opts.carry, force: opts.force });
      } catch (e) {
        await server.close(); // never leave an empty server (and a taken port) behind
        throw e;
      }
      const { entry, prepared } = result;
      if (webhookOrigin) console.error(`frameback: webhook push enabled -> ${webhookOrigin} (opt-in; human events only)`);
      announce(server.port, entry.rid, entry.reviewDir, !!opts.share);
      report(prepared.carried, prepared.warnings);
      if (opts.dev) {
        console.error("frameback: dev mode — the API is served here, the UI comes from the Vite dev server");
        console.error(`frameback: dev mode accepts cross-origin requests from the Vite dev server (port ${DEV_UI_PORT}) only`);
      }
      if (server.share) {
        printShare(server.share.links(entry.rid));
        for (const line of shareWarning(opts.shareTtl ?? DEFAULT_SHARE_TTL_HOURS)) console.error(line);
      }
      if (opts.open) await openBrowser(`${server.url}/?r=${encodeURIComponent(entry.rid)}`);

      const shutdown = () => void server.close().then(() => process.exit(0));
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return; // the listening server keeps the process alive
    }
  }
  throw new Error(`no free port in ${opts.port}–${opts.port + PORT_SPAN} (use --port)`);
}
