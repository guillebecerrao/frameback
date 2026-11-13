import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as S from "./store.js";
import { checkWebhookConfig, fireWebhook } from "./webhook.js";
import type { Event } from "./schema.js";

const ENV = ["FRAMEBACK_WEBHOOK_URL", "FRAMEBACK_WEBHOOK_SECRET", "FRAMEBACK_WEBHOOK_EVENTS", "FRAMEBACK_WEBHOOK_ROOT"] as const;
const ev = (over: Partial<Event> = {}): Event =>
  ({ seq: 7, at: "2026-01-01T00:00:00.000Z", type: "review.submitted", review: "final_v1", actor: "human", data: { round: 1 }, ...over }) as Event;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("webhook push", () => {
  it("does nothing unless FRAMEBACK_WEBHOOK_URL is set", async () => {
    fireWebhook(ev(), "/r");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts review.submitted by the human, with a verifiable signature", async () => {
    process.env.FRAMEBACK_WEBHOOK_URL = "http://127.0.0.1:9/hook";
    process.env.FRAMEBACK_WEBHOOK_SECRET = "s3cret";
    fireWebhook(ev(), "/videos/review/final_v1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:9/hook");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ event_type: "review.submitted", review: "final_v1", seq: 7, reviewDir: "review/final_v1" });
    const ts = init.headers["x-webhook-timestamp"];
    const expected = createHmac("sha256", "s3cret").update(`${ts}.${init.body}`).digest("hex");
    expect(init.headers["x-webhook-signature-v2"]).toBe(expected);
  });

  it("skips agent events and event types that were not requested", async () => {
    process.env.FRAMEBACK_WEBHOOK_URL = "http://127.0.0.1:9/hook";
    fireWebhook(ev({ actor: "agent" }), "/r");
    fireWebhook(ev({ type: "comment.created" }), "/r");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.FRAMEBACK_WEBHOOK_EVENTS = "comment.created";
    fireWebhook(ev({ type: "comment.created" }), "/r");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("retries a failing endpoint and never throws into the caller", async () => {
    process.env.FRAMEBACK_WEBHOOK_URL = "http://127.0.0.1:9/hook";
    fetchMock.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(new Response("ok"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => fireWebhook(ev(), "/r")).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    err.mockRestore();
  });

  it("makes reviewDir findable with FRAMEBACK_WEBHOOK_ROOT, never absolute", async () => {
    process.env.FRAMEBACK_WEBHOOK_URL = "http://127.0.0.1:9/hook";
    process.env.FRAMEBACK_WEBHOOK_ROOT = path.resolve("/videos");
    fireWebhook(ev(), path.resolve("/videos/client-a/review/final_v1"));
    fireWebhook(ev(), path.resolve("/elsewhere/review/final_v1"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const dirs = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).reviewDir);
    expect(dirs).toEqual(["client-a/review/final_v1", "review/final_v1"]);
  });

  it("does not follow redirects and ignores review.video_adopted by default", async () => {
    process.env.FRAMEBACK_WEBHOOK_URL = "http://127.0.0.1:9/hook";
    fireWebhook(ev({ type: "review.video_adopted" as Event["type"] }), "/r");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    fireWebhook(ev(), "/r");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe("error");
  });

  it("validates the configured URL", () => {
    expect(checkWebhookConfig()).toBeUndefined();
    process.env.FRAMEBACK_WEBHOOK_URL = "http://host.docker.internal:8644/webhooks/x";
    expect(checkWebhookConfig()).toBe("http://host.docker.internal:8644");
    process.env.FRAMEBACK_WEBHOOK_URL = "not a url";
    expect(() => checkWebhookConfig()).toThrow(/valid URL/);
    process.env.FRAMEBACK_WEBHOOK_URL = "file:///etc/passwd";
    expect(() => checkWebhookConfig()).toThrow(/http\(s\)/);
  });

  it("fires from the store when the reviewer submits, but not on comment.created", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fb-wh-"));
    const video = path.join(tmp, "final_v1.mp4");
    await fs.writeFile(video, "x");
    process.env.FRAMEBACK_WEBHOOK_URL = "http://127.0.0.1:9/hook";
    const { dir } = await S.openReview(video);
    await S.createComment(dir, { anchor: { time: { start: 1 } }, category: "cut", body: "trim" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    await S.submitReview(dir);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).event_type).toBe("review.submitted");
  });
});
