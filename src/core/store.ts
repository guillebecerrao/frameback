/**
 * Frameback core store — the ONLY module that writes review files.
 *
 * Guarantees (see docs/PROTOCOL.md):
 *  - every mutation is a read-modify-write under a per-review lock (mkdir-based, stale locks are stolen)
 *  - JSON files are written atomically (tmp + rename)
 *  - write order on create: snapshot -> comment -> event
 *  - events.ndjson is append-only with a monotonically increasing `seq` (starting at 1)
 */
import { fireWebhook } from "./webhook.js";
import { promises as fs, constants as fsc } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { VideoStatus } from "./api.js";
import { remapAnchor } from "./remap.js";
import {
  SCHEMA_VERSION,
  Comment,
  NewComment,
  CommentPatch,
  AgentPatch,
  Review,
  Event,
  type Actor,
  type AgentStatus,
  type EventType,
  type HumanStatus,
  type ReviewState,
  type Timeline,
  type VideoFingerprint,
  type VideoInfo,
} from "./schema.js";

// ------------------------------------------------------------------ paths ----

export const REVIEW_DIR_NAME = "review";
export const REVIEW_FILE = "review.json";
export const TIMELINE_FILE = "timeline.json";
export const EVENTS_FILE = "events.ndjson";
const SEQ_FILE = ".seq";
const LOCK_DIR = ".lock";

/** `<dir>/<stem>.<ext>` -> `<dir>/review/<stem>` */
export function reviewDirForVideo(videoPath: string): string {
  const abs = path.resolve(videoPath);
  const stem = path.basename(abs, path.extname(abs));
  return path.join(path.dirname(abs), REVIEW_DIR_NAME, stem);
}

/**
 * Accepts a video file path, a review dir, or a review.json path and returns the absolute review dir.
 * Does not require the review to exist (callers like `watch` may wait for it).
 */
export async function resolveReviewDir(arg: string): Promise<string> {
  const abs = path.resolve(arg);
  if (path.basename(abs) === REVIEW_FILE) return path.dirname(abs);
  const st = await fs.stat(abs).catch(() => null);
  if (st?.isDirectory()) return abs;
  if (st?.isFile()) return reviewDirForVideo(abs);
  // does not exist: a path with a video-like extension is a video, otherwise a review dir
  return path.extname(abs) ? reviewDirForVideo(abs) : abs;
}

export const p = {
  review: (dir: string) => path.join(dir, REVIEW_FILE),
  timeline: (dir: string) => path.join(dir, TIMELINE_FILE),
  events: (dir: string) => path.join(dir, EVENTS_FILE),
  comments: (dir: string) => path.join(dir, "comments"),
  comment: (dir: string, id: string) => path.join(dir, "comments", `${id}.json`),
  snapshots: (dir: string) => path.join(dir, "snapshots"),
  snapshot: (dir: string, id: string) => path.join(dir, "snapshots", `${id}.jpg`),
};

/** Make `target` relative to the review dir, POSIX separators. */
export function relToReview(reviewDir: string, target: string): string {
  return path.relative(reviewDir, path.resolve(target)).split(path.sep).join("/");
}

/** Resolve a path stored relative to the review dir. */
export function fromReview(reviewDir: string, rel: string): string {
  return path.resolve(reviewDir, rel);
}

/**
 * Like fromReview, but the result must stay inside `reviewDir` (or, when `within` is given, inside that
 * sub-directory of it). Review folders can come from elsewhere, so stored relative paths are untrusted.
 * Returns null when the path escapes.
 */
export function insideReview(reviewDir: string, rel: string, within?: string): string | null {
  const root = path.resolve(reviewDir, within ?? ".");
  const abs = path.resolve(reviewDir, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

// ------------------------------------------------------------------- utils ----

export const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function exists(f: string): Promise<boolean> {
  try {
    await fs.access(f, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function atomicWriteJson(file: string, obj: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

// -------------------------------------------------------------------- lock ----

/** A lock older than this is stolen. Waiters give up later than this, so a stale lock never fails a writer. */
const STALE_MS = 10_000;
/** An owner-less lock (writer crashed between mkdir and writing the owner file) goes stale much sooner. */
const ORPHAN_STALE_MS = 1_500;
const LOCK_TIMEOUT_MS = 15_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Run `fn` while holding the review lock. Re-entrant within the same call chain is NOT supported. */
export async function withLock<T>(reviewDir: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(reviewDir, { recursive: true });
  const lock = path.join(reviewDir, LOCK_DIR);
  const started = Date.now();
  let delay = 5;
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, "owner"), JSON.stringify({ pid: process.pid, at: now() }));
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // stale? (owner dead, or lock older than STALE_MS)
      try {
        const st = await fs.stat(lock);
        let ownerPid: number | null = null;
        try {
          ownerPid = JSON.parse(await fs.readFile(path.join(lock, "owner"), "utf8")).pid ?? null;
        } catch {
          /* owner file not written yet */
        }
        const age = Date.now() - st.mtimeMs;
        const old = age > (ownerPid === null ? ORPHAN_STALE_MS : STALE_MS);
        const dead = ownerPid !== null && ownerPid !== process.pid && !pidAlive(ownerPid);
        if (old || dead) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat: retry immediately
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for lock ${lock}`);
      }
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 100);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ events ----

/** Append an event. MUST be called while holding the lock. */
async function appendEventLocked(
  reviewDir: string,
  e: { type: EventType; review: string; actor: Actor; commentId?: string; data?: Record<string, unknown> },
): Promise<Event> {
  const seqFile = path.join(reviewDir, SEQ_FILE);
  let last = 0;
  try {
    last = parseInt(await fs.readFile(seqFile, "utf8"), 10) || 0;
  } catch {
    last = await lastSeqFromLog(reviewDir);
  }
  const ev: Event = Event.parse({ seq: last + 1, at: now(), ...e });
  await fs.appendFile(p.events(reviewDir), JSON.stringify(ev) + "\n");
  await atomicWrite(seqFile, String(ev.seq));
  fireWebhook(ev, reviewDir);
  return ev;
}

async function lastSeqFromLog(reviewDir: string): Promise<number> {
  const evs = await readEvents(reviewDir, 0);
  return evs.length ? evs[evs.length - 1].seq : 0;
}

/** Events with seq > sinceSeq. Only complete (newline-terminated) lines are returned. */
export async function readEvents(reviewDir: string, sinceSeq = 0): Promise<Event[]> {
  let raw: string;
  try {
    raw = await fs.readFile(p.events(reviewDir), "utf8");
  } catch {
    return [];
  }
  const end = raw.lastIndexOf("\n");
  if (end < 0) return [];
  const out: Event[] = [];
  for (const line of raw.slice(0, end).split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as Event;
      if (ev.seq > sinceSeq) out.push(ev);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export async function lastSeq(reviewDir: string): Promise<number> {
  try {
    return parseInt(await fs.readFile(path.join(reviewDir, SEQ_FILE), "utf8"), 10) || 0;
  } catch {
    return lastSeqFromLog(reviewDir);
  }
}

// ------------------------------------------------------------------ review ----

export interface FrozenTimeline {
  timeline: Timeline;
  origin: string;
  sourceFile?: string | null; // absolute path of the sidecar / edl used
  sourceMtime?: string | null;
  approximate?: boolean;
  warnings?: string[];
}

export interface OpenReviewOptions {
  /** metadata known about the video (duration/fps/size); merged into review.video */
  videoInfo?: Partial<Omit<VideoInfo, "file">>;
  /** resolved timeline to freeze into the review dir — used when the review is created, or when `refreshTimeline` is set */
  timeline?: FrozenTimeline | null;
  /** re-freeze `timeline` into an existing review (explicit --edl / --timeline); the timeline is advisory */
  refreshTimeline?: boolean;
  /** stem of the version this review was carried from */
  previous?: string | null;
}

export async function reviewExists(reviewDir: string): Promise<boolean> {
  return exists(p.review(reviewDir));
}

export async function readReview(reviewDir: string): Promise<Review> {
  return Review.parse(await readJson(p.review(reviewDir)));
}

/** Absolute path of the reviewed video. */
export async function videoPathOf(reviewDir: string): Promise<string> {
  const r = await readReview(reviewDir);
  return fromReview(reviewDir, r.video.file);
}

/**
 * Create the review for `videoPath` if missing (emits `review.opened`), or return the existing one
 * (merging any new videoInfo). The timeline is frozen only at creation.
 */
export async function openReview(videoPath: string, opts: OpenReviewOptions = {}): Promise<{ dir: string; review: Review; created: boolean }> {
  const dir = reviewDirForVideo(videoPath);
  return withLock(dir, async () => {
    const freeze = async (tl: FrozenTimeline): Promise<NonNullable<Review["timeline"]>> => {
      await atomicWriteJson(p.timeline(dir), tl.timeline);
      return {
        file: TIMELINE_FILE,
        origin: tl.origin,
        sourceFile: tl.sourceFile ? relToReview(dir, tl.sourceFile) : null,
        sourceMtime: tl.sourceMtime ?? null,
        approximate: tl.approximate ?? false,
        warnings: tl.warnings ?? [],
      };
    };
    if (await exists(p.review(dir))) {
      let review = Review.parse(await readJson(p.review(dir)));
      if (opts.refreshTimeline && opts.timeline) {
        review = { ...review, timeline: await freeze(opts.timeline), updatedAt: now() };
        await atomicWriteJson(p.review(dir), review);
      }
      if (opts.videoInfo) {
        const merged = { ...review.video };
        for (const [k, v] of Object.entries(opts.videoInfo)) {
          if (v !== undefined && v !== null && (merged as any)[k] == null) (merged as any)[k] = v;
        }
        if (JSON.stringify(merged) !== JSON.stringify(review.video)) {
          review = { ...review, video: merged, updatedAt: now() };
          await atomicWriteJson(p.review(dir), review);
        }
      }
      return { dir, review, created: false };
    }
    const t = now();
    let timelineRef: Review["timeline"] = null;
    if (opts.timeline) {
      timelineRef = await freeze(opts.timeline);
    }
    const review: Review = Review.parse({
      schemaVersion: SCHEMA_VERSION,
      id: path.basename(dir),
      video: {
        file: relToReview(dir, videoPath),
        duration: opts.videoInfo?.duration ?? null,
        fps: opts.videoInfo?.fps ?? null,
        width: opts.videoInfo?.width ?? null,
        height: opts.videoInfo?.height ?? null,
        fingerprint: await fingerprintVideo(videoPath).catch(() => null),
      },
      timeline: timelineRef,
      state: "reviewing",
      round: 1,
      previous: opts.previous ?? null,
      nextVideo: null,
      createdAt: t,
      submittedAt: null,
      updatedAt: t,
    });
    await fs.mkdir(p.comments(dir), { recursive: true });
    await atomicWriteJson(p.review(dir), review);
    await appendEventLocked(dir, {
      type: "review.opened",
      review: review.id,
      actor: "system",
      data: { video: review.video.file },
    });
    return { dir, review, created: true };
  });
}

// ------------------------------------------------------------ fingerprint ----

const FINGERPRINT_CHUNK = 64 * 1024;

/** size + mtime + a hash of the first and last 64 KB: cheap even for multi-GB files. */
export async function fingerprintVideo(file: string): Promise<VideoFingerprint> {
  const fh = await fs.open(file, "r");
  try {
    const st = await fh.stat();
    const hash = createHash("sha1");
    const buf = Buffer.alloc(FINGERPRINT_CHUNK);
    const head = await fh.read(buf, 0, FINGERPRINT_CHUNK, 0);
    hash.update(buf.subarray(0, head.bytesRead));
    if (st.size > FINGERPRINT_CHUNK) {
      const start = Math.max(FINGERPRINT_CHUNK, st.size - FINGERPRINT_CHUNK);
      const tail = await fh.read(buf, 0, FINGERPRINT_CHUNK, start);
      hash.update(buf.subarray(0, tail.bytesRead));
    }
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs), hash: hash.digest("hex") };
  } finally {
    await fh.close();
  }
}

/** Same content as far as the fingerprint can tell. A different mtime alone (e.g. `touch`) is not a change. */
export function sameVideo(a: VideoFingerprint, b: VideoFingerprint): boolean {
  return a.size === b.size && a.hash === b.hash;
}

/**
 * Compare the video on disk with the fingerprint saved when the review was opened. A review without a
 * fingerprint (made before this existed) adopts the current file silently. A missing file is not a change.
 */
export async function checkVideo(reviewDir: string): Promise<VideoStatus> {
  const review = await readReview(reviewDir);
  const current = await fingerprintVideo(fromReview(reviewDir, review.video.file)).catch(() => null);
  const stored = review.video.fingerprint ?? null;
  if (!stored) {
    if (current) await withLock(reviewDir, async () => {
      const r = await readReview(reviewDir);
      if (!r.video.fingerprint) await atomicWriteJson(p.review(reviewDir), { ...r, video: { ...r.video, fingerprint: current }, updatedAt: now() });
    });
    return { changed: false, stored: current, current };
  }
  return { changed: Boolean(current && !sameVideo(stored, current)), stored, current };
}

/** Accept the video as it is now (explicit `open --force`); recorded as `review.video_adopted`. */
export async function adoptVideo(reviewDir: string, actor: Actor = "human"): Promise<Review> {
  return withLock(reviewDir, async () => {
    const r = await readReview(reviewDir);
    const current = await fingerprintVideo(fromReview(reviewDir, r.video.file));
    const previous = r.video.fingerprint ?? null;
    const next: Review = { ...r, video: { ...r.video, fingerprint: current }, updatedAt: now() };
    await atomicWriteJson(p.review(reviewDir), next);
    await appendEventLocked(reviewDir, { type: "review.video_adopted", review: r.id, actor, data: { previous, current } });
    return next;
  });
}

export async function readTimeline(reviewDir: string): Promise<Timeline | null> {
  const r = await readReview(reviewDir);
  if (!r.timeline) return null;
  try {
    const file = insideReview(reviewDir, r.timeline.file);
    if (!file) return null;
    return await readJson<Timeline>(file);
  } catch {
    return null;
  }
}

export async function countComments(reviewDir: string) {
  const cs = await listComments(reviewDir);
  const live = cs.filter((c) => c.human.status !== "deleted");
  const by = (s: AgentStatus) => live.filter((c) => c.agent.status === s).length;
  return {
    total: live.length,
    pending: by("pending"),
    acknowledged: by("acknowledged"),
    in_progress: by("in_progress"),
    prepared: by("prepared"),
    applied: by("applied"),
    needs_info: by("needs_info"),
    declined: by("declined"),
    /** comments the reviewer reopened (the agent status is reset to pending when that happens) */
    reopened: live.filter((c) => c.human.status === "reopened").length,
    must: live.filter((c) => c.priority === "must").length,
  };
}

/** Human presses "Process review": reviewing -> submitted. */
export async function submitReview(reviewDir: string): Promise<Review> {
  const counts = await countComments(reviewDir);
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    if (r.state !== "reviewing") throw new StoreError("conflict", `review is '${r.state}', not 'reviewing'`);
    const t = now();
    const next: Review = { ...r, state: "submitted", submittedAt: t, updatedAt: t };
    await atomicWriteJson(p.review(reviewDir), next);
    await appendEventLocked(reviewDir, { type: "review.submitted", review: r.id, actor: "human", data: { counts, round: r.round } });
    return next;
  });
}

/** Human reopens a submitted review (adds more feedback): submitted|processing -> reviewing, round++. */
export async function reopenReview(reviewDir: string): Promise<Review> {
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    if (r.state === "reviewing") return r;
    if (r.state === "delivered" || r.state === "closed") {
      // A delivered/closed review stays read-only once a newer version exists (feedback belongs there).
      // Without one, it is still the latest cut, so the reviewer can reopen it to keep commenting.
      const next = r.nextVideo ? await fs.stat(fromReview(reviewDir, r.nextVideo)).catch(() => null) : null;
      if (next?.isFile()) {
        throw new StoreError("conflict", `review is '${r.state}' and a newer version exists (${r.nextVideo}): review that one instead`);
      }
    } else if (r.state !== "submitted" && r.state !== "processing") {
      throw new StoreError("conflict", `review is '${r.state}': it cannot be reopened`);
    }
    const next: Review = { ...r, state: "reviewing", round: r.round + 1, updatedAt: now() };
    await atomicWriteJson(p.review(reviewDir), next);
    await appendEventLocked(reviewDir, {
      type: "review.state", review: r.id, actor: "human", data: { state: "reviewing", reopened: true, round: next.round },
    });
    return next;
  });
}

/** Agent/system review state transitions: processing | delivered | closed. */
export async function setReviewState(
  reviewDir: string,
  state: Extract<ReviewState, "processing" | "delivered" | "closed">,
  opts: { nextVideo?: string | null; actor?: Actor; force?: boolean } = {},
): Promise<Review> {
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    if (!opts.force) {
      // PROTOCOL §7: reviewing -> submitted (human) -> processing -> delivered; closed is terminal
      const from = r.state;
      const allowed: Record<typeof state, ReviewState[]> = {
        processing: ["submitted"],
        delivered: ["submitted", "processing"],
        closed: ["reviewing", "submitted", "processing", "delivered"],
      };
      if (!allowed[state].includes(from)) {
        throw new StoreError("conflict", `cannot set '${state}' while the review is '${from}' (allowed from: ${allowed[state].join(", ")}; pass force to override)`);
      }
      if (state === "delivered") {
        const target = opts.nextVideo ?? (r.nextVideo ? fromReview(reviewDir, r.nextVideo) : null);
        if (!target) throw new StoreError("invalid", "delivered needs the next version's file (--next-video)");
        const st = await fs.stat(target).catch(() => null);
        if (!st?.isFile()) throw new StoreError("invalid", `next video not found: ${target}`);
      }
    }
    const next: Review = {
      ...r,
      state,
      nextVideo: opts.nextVideo !== undefined && opts.nextVideo !== null ? relToReview(reviewDir, opts.nextVideo) : r.nextVideo ?? null,
      updatedAt: now(),
    };
    await atomicWriteJson(p.review(reviewDir), next);
    await appendEventLocked(reviewDir, {
      type: "review.state", review: r.id, actor: opts.actor ?? "agent", data: { state, nextVideo: next.nextVideo ?? null },
    });
    return next;
  });
}

/** Merge late-discovered video metadata (e.g. reported by the UI) without overwriting known values. */
export async function updateVideoInfo(reviewDir: string, info: Partial<Omit<VideoInfo, "file">>): Promise<Review> {
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    const video = { ...r.video };
    for (const [k, v] of Object.entries(info)) if (v != null && (video as any)[k] == null) (video as any)[k] = v;
    const next = { ...r, video, updatedAt: now() };
    await atomicWriteJson(p.review(reviewDir), next);
    return next;
  });
}

// ---------------------------------------------------------------- comments ----

export class StoreError extends Error {
  constructor(public code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
  }
}

export async function listComments(reviewDir: string, opts: { includeDeleted?: boolean } = {}): Promise<Comment[]> {
  let files: string[];
  try {
    files = await fs.readdir(p.comments(reviewDir));
  } catch {
    return [];
  }
  const out: Comment[] = [];
  for (const f of files.filter((f) => /^c-\d+\.json$/.test(f)).sort()) {
    try {
      const c = Comment.parse(await readJson(path.join(p.comments(reviewDir), f)));
      if (opts.includeDeleted || c.human.status !== "deleted") out.push(c);
    } catch {
      /* skip unreadable / half-migrated file */
    }
  }
  return out.sort((a, b) => a.anchor.time.start - b.anchor.time.start || a.id.localeCompare(b.id));
}

export async function readComment(reviewDir: string, id: string): Promise<Comment> {
  const f = p.comment(reviewDir, id);
  if (!(await exists(f))) throw new StoreError("not_found", `comment ${id} not found`);
  return Comment.parse(await readJson(f));
}

async function nextCommentIdLocked(reviewDir: string): Promise<string> {
  let max = 0;
  try {
    for (const f of await fs.readdir(p.comments(reviewDir))) {
      const m = /^c-(\d+)\.json$/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    /* none yet */
  }
  return `c-${String(max + 1).padStart(4, "0")}`;
}

function assertReviewing(r: Review) {
  if (r.state !== "reviewing") {
    throw new StoreError("conflict", `review is '${r.state}': reopen it to add or edit comments`);
  }
}

/**
 * Create a human comment. Order: snapshot -> comment -> event.
 * `snapshot` is JPEG bytes (region already drawn by the client).
 */
export async function createComment(reviewDir: string, input: NewComment, opts: { snapshot?: Buffer | null } = {}): Promise<Comment> {
  const parsed = NewComment.parse(input);
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    assertReviewing(r);
    const id = await nextCommentIdLocked(reviewDir);
    let snapshot: string | null = null;
    if (opts.snapshot && opts.snapshot.length) {
      await atomicWrite(p.snapshot(reviewDir, id), opts.snapshot);
      snapshot = `snapshots/${id}.jpg`;
    }
    const t = now();
    const c: Comment = Comment.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      createdAt: t,
      updatedAt: t,
      anchor: normalizeAnchor(parsed.anchor),
      category: parsed.category,
      action: parsed.action ?? null,
      priority: parsed.priority,
      body: parsed.body,
      snapshot,
      human: { status: "open", revision: 1 },
      agent: { status: "pending", plan: null, reply: null, appliedIn: null, seenRevision: null, updatedAt: null },
      thread: [],
      carriedFrom: null,
    });
    await atomicWriteJson(p.comment(reviewDir, id), c);
    await appendEventLocked(reviewDir, {
      type: "comment.created",
      review: r.id,
      actor: "human",
      commentId: id,
      data: eventSummary(c),
    });
    return c;
  });
}

/** Everything an agent needs to act on a single notification. */
export function eventSummary(c: Comment): Record<string, unknown> {
  return {
    time: c.anchor.time,
    region: c.anchor.region ?? null,
    entity: c.anchor.entity ?? null,
    source: c.anchor.source ?? null,
    transcript: c.anchor.transcript ?? null,
    category: c.category,
    action: c.action ?? null,
    priority: c.priority,
    body: c.body,
    snapshot: c.snapshot ?? null,
    revision: c.human.revision,
  };
}

function normalizeAnchor<T extends { time: { start: number; end?: number | null } }>(a: T): T {
  const { start, end } = a.time;
  if (end != null && end < start) return { ...a, time: { start: end, end: start } };
  if (end != null && end === start) return { ...a, time: { start, end: null } };
  return { ...a, time: { start, end: end ?? null } };
}

const CONTENT_FIELDS = ["anchor", "category", "action", "priority", "body"] as const;

/** Human edits content fields (body/anchor/category/action/priority). Bumps human.revision. */
export async function updateCommentHuman(reviewDir: string, id: string, patch: CommentPatch): Promise<Comment> {
  const parsed = CommentPatch.parse(patch);
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    assertReviewing(r);
    const c = await readComment(reviewDir, id);
    const changed = CONTENT_FIELDS.filter(
      (k) => parsed[k] !== undefined && JSON.stringify(parsed[k]) !== JSON.stringify((c as any)[k]),
    );
    if (!changed.length) return c;
    const next: Comment = Comment.parse({
      ...c,
      ...Object.fromEntries(changed.map((k) => [k, k === "anchor" ? normalizeAnchor(parsed.anchor!) : parsed[k]])),
      human: { ...c.human, revision: c.human.revision + 1 },
      updatedAt: now(),
    });
    await atomicWriteJson(p.comment(reviewDir, id), next);
    await appendEventLocked(reviewDir, {
      type: "comment.updated", review: r.id, actor: "human", commentId: id,
      data: { fields: changed, ...eventSummary(next) },
    });
    return next;
  });
}

/** Replace a comment's snapshot (e.g. after the human re-draws the region). */
export async function setSnapshot(reviewDir: string, id: string, jpeg: Buffer): Promise<Comment> {
  return withLock(reviewDir, async () => {
    const c = await readComment(reviewDir, id);
    await atomicWrite(p.snapshot(reviewDir, id), jpeg);
    const next = { ...c, snapshot: `snapshots/${id}.jpg`, updatedAt: now() };
    await atomicWriteJson(p.comment(reviewDir, id), next);
    return next;
  });
}

/** Human status: verified | reopened | resolved_by_human | deleted (soft) | open. */
export async function setHumanStatus(reviewDir: string, id: string, status: HumanStatus): Promise<Comment> {
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    const c = await readComment(reviewDir, id);
    if (c.human.status === status) return c;
    if (status === "deleted") assertReviewing(r);
    let agent = c.agent;
    if (status === "reopened" && ["applied", "prepared", "declined"].includes(agent.status)) {
      // the fix was rejected: it is pending work for the agent again (plan/reply stay as context)
      agent = { ...agent, status: "pending", seenRevision: null, updatedAt: now() };
    }
    const next: Comment = { ...c, agent, human: { ...c.human, status }, updatedAt: now() };
    await atomicWriteJson(p.comment(reviewDir, id), next);
    await appendEventLocked(reviewDir, {
      type: status === "deleted" ? "comment.deleted" : "comment.human_status",
      review: r.id, actor: "human", commentId: id, data: { status, body: c.body, time: c.anchor.time, agentStatus: next.agent.status },
    });
    return next;
  });
}

/** Agent updates its own fields. Allowed in any review state. */
export async function updateCommentAgent(reviewDir: string, id: string, patch: AgentPatch): Promise<Comment> {
  const parsed = AgentPatch.parse(patch);
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    const c = await readComment(reviewDir, id);
    const agent = { ...c.agent };
    for (const [k, v] of Object.entries(parsed)) if (v !== undefined) (agent as any)[k] = v;
    // acting on a comment implies the agent has seen its current revision unless told otherwise
    if (parsed.status && parsed.seenRevision === undefined && parsed.status !== "pending") {
      agent.seenRevision = c.human.revision;
    }
    agent.updatedAt = now();
    const next: Comment = Comment.parse({ ...c, agent, updatedAt: agent.updatedAt });
    await atomicWriteJson(p.comment(reviewDir, id), next);
    await appendEventLocked(reviewDir, {
      type: "comment.agent_status", review: r.id, actor: "agent", commentId: id,
      data: { status: agent.status, plan: agent.plan ?? null, reply: agent.reply ?? null, appliedIn: agent.appliedIn ?? null },
    });
    return next;
  });
}

/** Append a thread message (human or agent). Allowed in any review state. */
export async function addThreadMessage(reviewDir: string, id: string, author: "human" | "agent", text: string): Promise<Comment> {
  if (!text.trim()) throw new StoreError("invalid", "empty message");
  return withLock(reviewDir, async () => {
    const r = Review.parse(await readJson(p.review(reviewDir)));
    const c = await readComment(reviewDir, id);
    const at = now();
    const next: Comment = { ...c, thread: [...c.thread, { author, at, text }], updatedAt: at };
    await atomicWriteJson(p.comment(reviewDir, id), next);
    await appendEventLocked(reviewDir, {
      type: "thread.message", review: r.id, actor: author, commentId: id, data: { author, text },
    });
    return next;
  });
}

/** Helper for stale detection (human edited after the agent acted). */
export function isStale(c: Comment): boolean {
  return c.agent.seenRevision != null && c.agent.seenRevision < c.human.revision;
}

// ------------------------------------------------------------------- carry ----

/**
 * Copy comments from a previous version's review into a new one for verification.
 * Copies non-deleted comments that are not verified/resolved; keeps agent fields as they were (no rework is triggered),
 * sets human.status = "open", carriedFrom = {review, id}, and emits `comment.carried` (actor system).
 * Anchors are remapped through source time using both reviews' frozen timelines (see remap.ts); without source
 * info the times are kept as-is (method "identity"). Skips comments already carried.
 */
export async function carryComments(fromReviewDir: string, toReviewDir: string): Promise<Comment[]> {
  if (path.resolve(fromReviewDir) === path.resolve(toReviewDir)) {
    throw new StoreError("invalid", "cannot carry a review into itself");
  }
  const from = await readReview(fromReviewDir);
  // comments the reviewer already closed (verified / resolved) are not verification work any more
  const src = (await listComments(fromReviewDir)).filter(
    (c) => c.human.status !== "verified" && c.human.status !== "resolved_by_human",
  );
  return withLock(toReviewDir, async () => {
    const to = Review.parse(await readJson(p.review(toReviewDir)));
    const already = new Set(
      (await listCommentsUnlocked(toReviewDir)).filter((c) => c.carriedFrom).map((c) => `${c.carriedFrom!.review}/${c.carriedFrom!.id}`),
    );
    const out: Comment[] = [];
    const oldTl = await readTimeline(fromReviewDir);
    const newTl = await readTimeline(toReviewDir);
    for (const c of src) {
      if (already.has(`${from.id}/${c.id}`)) continue;
      const id = await nextCommentIdLocked(toReviewDir);
      let snapshot: string | null = null;
      if (c.snapshot) {
        try {
          await atomicWrite(p.snapshot(toReviewDir, id), await fs.readFile(fromReview(fromReviewDir, c.snapshot)));
          snapshot = `snapshots/${id}.jpg`;
        } catch {
          /* snapshot missing: carry without it */
        }
      }
      const t = now();
      const { anchor, from: oldTime, remap } = remapAnchor(oldTl, newTl, c.anchor, to.video.fps);
      const nc: Comment = Comment.parse({
        ...c,
        anchor,
        id,
        createdAt: t,
        updatedAt: t,
        snapshot,
        human: { status: "open", revision: c.human.revision },
        carriedFrom: { review: from.id, id: c.id, time: oldTime, remap },
      });
      await atomicWriteJson(p.comment(toReviewDir, id), nc);
      await appendEventLocked(toReviewDir, {
        type: "comment.carried", review: to.id, actor: "system", commentId: id,
        data: { from: { review: from.id, id: c.id, time: oldTime }, agentStatus: c.agent.status, remap, ...eventSummary(nc) },
      });
      out.push(nc);
    }
    if (!to.previous) {
      await atomicWriteJson(p.review(toReviewDir), { ...to, previous: from.id, updatedAt: now() });
    }
    return out;
  });
}

async function listCommentsUnlocked(reviewDir: string) {
  return listComments(reviewDir, { includeDeleted: true });
}
