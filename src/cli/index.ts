/** Frameback CLI (`frameback …`). Human-friendly errors, `--json` on read commands, NDJSON `watch` for agents. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { ZodError } from "zod";
import {
  AGENT_STATUSES,
  AgentStatus,
  HumanStatus,
  DEFAULT_PORT,
  StoreError,
  VERSION,
  addThreadMessage,
  carryComments,
  countComments,
  edlToTimeline,
  fromReview,
  isStale,
  exportReview,
  lastSeq,
  listComments,
  probeVideo,
  readComment,
  readReview,
  renderComment,
  resolveReviewDir,
  resolveTimeline,
  reviewExists,
  setReviewState,
  updateCommentAgent,
  type Comment,
  type Timeline,
} from "../core/index.js";
import { InvalidVideoError, VideoChangedError, packageRoot, prepareReview } from "../server/index.js";
import { formatCommentRow } from "./format.js";
import { openCommand } from "./open.js";
import { MAX_SHARE_TTL_HOURS, parseShareTtl } from "../server/share.js";
import { humanViewNotice, parseActors, parseCursorName, parseEventType, watchReview } from "./watch.js";

// ----------------------------------------------------------------- helpers ----

function describeError(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  if (e instanceof StoreError || e instanceof InvalidVideoError || e instanceof VideoChangedError) return e.message;
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return `file not found: ${err.path ?? ""}`.trim();
  return err instanceof Error ? err.message : String(e);
}

/** Wrap a command action: no stack traces, exit code 1 on failure. */
function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(`frameback: ${describeError(e)}`);
      process.exitCode = 1;
    }
  };
}

async function existingReviewDir(target: string): Promise<string> {
  const dir = await resolveReviewDir(target);
  if (!(await reviewExists(dir))) {
    throw new Error(`no review found at ${dir} (create it with: frameback open <video>)`);
  }
  return dir;
}

const out = (text: string) => console.log(text);
const printJson = (value: unknown) => out(JSON.stringify(value, null, 2));

function shareArg(value: string): "tailscale" {
  if (value !== "tailscale") throw new InvalidArgumentError("use `--share` (all private networks) or `--share tailscale`");
  return value;
}

function ttlArg(value: string): number {
  try {
    return parseShareTtl(value);
  } catch (e) {
    throw new InvalidArgumentError((e as Error).message);
  }
}

function intArg(name: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError(`${name} must be a non-negative integer`);
    return n;
  };
}

/** `7`, `c-7` and `c-0007` all mean the same comment; anything else is rejected before it reaches the store. */
function commentIdArg(value: string): string {
  const m = /^(?:c-)?(\d{1,})$/.exec(value.trim());
  if (!m) throw new Error(`invalid comment id '${value}' (expected e.g. c-0007 or 7)`);
  return `c-${m[1].padStart(4, "0")}`;
}

/** Comments with a snapshot get its absolute path, so JSON consumers need not know the review dir layout. */
function withSnapshotPath<C extends Comment>(c: C, dir: string): C & { snapshotPath: string | null } {
  return { ...c, snapshotPath: c.snapshot ? fromReview(dir, c.snapshot) : null };
}

function agentStatusArg(value: string): AgentStatus {
  const parsed = AgentStatus.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(`expected one of: ${AGENT_STATUSES.join(", ")}`);
  return parsed.data;
}

// -------------------------------------------------------------------- program ----

const program = new Command();
program
  .name("frameback")
  .description("Local review tool for agentic video editing: anchor comments to frames, regions, ranges and timeline entities.")
  .version(VERSION)
  .showHelpAfterError();

program
  .command("open")
  .argument("<video>", "video file to review")
  .description("start the review UI for a video (or attach to a running Frameback server)")
  .option("--port <n>", "preferred port; the next 10 are tried if it is taken", intArg("port"), DEFAULT_PORT)
  .option("--no-open", "do not open a browser")
  .option("--edl <path>", "edl.json to build the timeline from")
  .option("--timeline <path>", "Frameback timeline sidecar")
  .option("--no-carry", "do not carry comments over from the previous _vN version")
  .option("--force", "keep reviewing a video that changed after it was opened (re-adopts the file as it is now)")
  .option("--dev", "API only; the Vite dev server serves the UI")
  .option("--webhook <url>", "POST human events (review.submitted, thread.message) to this URL; secret via FRAMEBACK_WEBHOOK_SECRET")
  .option("--share [network]", "let another computer review with a private link: all private networks (Tailscale + home/office wifi), or `tailscale` for Tailscale only", shareArg)
  .option("--share-ttl <hours>", `hours the share link stays valid (default 12, max ${MAX_SHARE_TTL_HOURS})`, ttlArg)
  .action(
    action((video: string, o) => {
      if (o.shareTtl !== undefined && !o.share) throw new Error("--share-ttl needs --share");
      return openCommand(video, { ...o, share: o.share === true ? "lan" : o.share });
    }),
  );

program
  .command("watch")
  .argument("<target>", "video file or review dir (may not exist yet)")
  .description("stream review events: NDJSON for agents (--json) or one readable line each (--text)")
  .option("--since <seq>", "replay events after this sequence number (overrides the saved cursor; --exit-on then only counts new events)", intArg("since"))
  .option("--tail", "start at the end of the log instead of replaying (overrides the saved cursor)")
  .option("--cursor <name>", "name of the saved cursor (default: watch); a restart without --since/--tail resumes after the last delivered event; use --since 0 to start over", parseCursorName)
  .option("--json", "one Event JSON per line (default when stdout is not a terminal)")
  .option("--text", "one human-readable line per event (default on a terminal)")
  .option("--exit-on <type>", "exit 0 right after printing the first NEW event of this type, e.g. review.submitted (replayed history does not count)")
  .option("--actor <list>", "only events written by these actors (comma separated: human,agent,system); use human,system to skip your own echoes")
  .action(
    action(async (target: string, o: { since?: number; tail?: boolean; cursor?: string; json?: boolean; text?: boolean; exitOn?: string; actor?: string }) => {
      if (o.json && o.text) throw new Error("use either --json or --text");
      const exitOn = o.exitOn ? parseEventType(o.exitOn) : undefined;
      const format = o.json ? "json" : o.text ? "text" : process.stdout.isTTY ? "text" : "json";
      const notice = humanViewNotice(Boolean(process.stdout.isTTY), Boolean(o.json));
      if (notice) console.error(`frameback: ${notice}`);
      const controller = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => controller.abort());
      process.stdout.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EPIPE") controller.abort();
      });
      await watchReview({
        target,
        since: o.since,
        tail: o.tail,
        cursor: o.cursor,
        format,
        exitOn,
        actors: o.actor ? parseActors(o.actor) : undefined,
        signal: controller.signal,
        write: (line) => new Promise<void>((resolve) => process.stdout.write(`${line}\n`, () => resolve())),
        log: (message) => console.error(`frameback: ${message}`),
      });
    }),
  );

program
  .command("list")
  .argument("<target>", "video file or review dir")
  .description("list a review's comments (deleted ones are left out unless --all)")
  .option("--agent-status <list>", "only these agent statuses (comma separated), e.g. pending,needs_info")
  .option("--human-status <list>", "only these human statuses (comma separated): open,verified,reopened,resolved_by_human,deleted")
  .option("--needs-work", "only comments the agent still has to act on: pending/acknowledged/in_progress/needs_info, stale or reopened")
  .option("--stale", "only comments the reviewer edited after the agent acted")
  .option("--all", "include deleted comments")
  .option("--json", "print { lastSeq, review, comments, deleted }; resume with `watch --since <lastSeq>`")
  .action(
    action(async (target: string, o: { agentStatus?: string; humanStatus?: string; needsWork?: boolean; stale?: boolean; all?: boolean; json?: boolean }) => {
      const dir = await existingReviewDir(target);
      const wanted = o.agentStatus?.split(",").map((s) => agentStatusArg(s.trim()));
      const wantedHuman = o.humanStatus?.split(",").map((s) => HumanStatus.parse(s.trim()));
      const [review, seq] = [await readReview(dir), await lastSeq(dir)];
      const everything = await listComments(dir, { includeDeleted: true });
      const open = ["pending", "acknowledged", "in_progress", "needs_info"];
      const keep = (c: Comment) =>
        (!wanted || wanted.includes(c.agent.status)) &&
        (!wantedHuman || wantedHuman.includes(c.human.status)) &&
        (!o.stale || isStale(c)) &&
        (!o.needsWork || (c.human.status !== "deleted" && (open.includes(c.agent.status) || isStale(c) || c.human.status === "reopened")));
      const showDeleted = o.all || wantedHuman?.includes("deleted");
      const live = everything.filter((c) => c.human.status !== "deleted");
      const deleted = everything.filter((c) => c.human.status === "deleted");
      const comments = (showDeleted ? everything : live).filter(keep);
      if (o.json) {
        // `deleted` is listed (compact) so a resumed agent can undo work it staged for a comment deleted since
        return printJson({
          lastSeq: seq,
          review,
          comments: comments.map((c) => withSnapshotPath(c, dir)),
          deleted: showDeleted ? undefined : deleted.map((c) => ({ id: c.id, body: c.body, time: c.anchor.time, agentStatus: c.agent.status })),
        });
      }
      out(`${review.id} · ${review.state} · round ${review.round} · ${comments.length} comment(s)${!showDeleted && deleted.length ? ` · ${deleted.length} deleted (use --all)` : ""} · lastSeq ${seq}`);
      for (const c of comments) out(formatCommentRow(c, dir));
    }),
  );

program
  .command("show")
  .argument("<target>", "video file or review dir")
  .argument("<commentId>", "e.g. c-0007 or 7")
  .description("show one comment in full")
  .option("--json", "print the comment JSON")
  .action(
    action(async (target: string, id: string, o: { json?: boolean }) => {
      const dir = await existingReviewDir(target);
      const comment = await readComment(dir, commentIdArg(id));
      if (o.json) return printJson(withSnapshotPath(comment, dir));
      out((await renderComment(dir, comment)).join("\n"));
    }),
  );

program
  .command("update")
  .argument("<target>", "video file or review dir")
  .argument("<commentId>")
  .description("write the agent's status / plan / reply on a comment")
  .option("--status <status>", `agent status: ${AGENT_STATUSES.join(" | ")}`, agentStatusArg)
  .option("--plan <text>", "what the agent will do / did")
  .option("--reply <text>", "short answer for the reviewer")
  .option("--applied-in <stem>", "version stem where the change landed, e.g. final_v3")
  .option("--seen-revision <n>", "human revision the agent acted on", intArg("seen-revision"))
  .option("--json", "print the updated comment JSON")
  .action(
    action(
      async (
        target: string,
        id: string,
        o: { status?: AgentStatus; plan?: string; reply?: string; appliedIn?: string; seenRevision?: number; json?: boolean },
      ) => {
        const patch = { status: o.status, plan: o.plan, reply: o.reply, appliedIn: o.appliedIn, seenRevision: o.seenRevision };
        if (Object.values(patch).every((v) => v === undefined)) {
          throw new Error("nothing to update (pass --status, --plan, --reply, --applied-in or --seen-revision)");
        }
        const comment = await updateCommentAgent(await existingReviewDir(target), commentIdArg(id), patch);
        out(o.json ? JSON.stringify(comment, null, 2) : `${comment.id} agent=${comment.agent.status}`);
      },
    ),
  );

program
  .command("reply")
  .argument("<target>", "video file or review dir")
  .argument("<commentId>")
  .argument("<message...>", "message for the reviewer (thread)")
  .description("append an agent message to a comment's thread")
  .action(
    action(async (target: string, id: string, message: string[]) => {
      await addThreadMessage(await existingReviewDir(target), commentIdArg(id), "agent", message.join(" "));
      out(`${commentIdArg(id)} replied`);
    }),
  );

program
  .command("review")
  .argument("<target>", "video file or review dir")
  .description("show the review state, or set it (agent: processing | delivered | closed)")
  .option("--state <state>", "processing | delivered | closed")
  .option("--next-video <path>", "the next version's file (required with --state delivered; must exist)")
  .option("--force", "skip the state-machine checks (processing only after submit, delivered only after processing, closed is final)")
  .option("--json", "print the review JSON")
  .action(
    action(async (target: string, o: { state?: string; nextVideo?: string; force?: boolean; json?: boolean }) => {
      const dir = await existingReviewDir(target);
      let review = await readReview(dir);
      if (o.state) {
        if (!["processing", "delivered", "closed"].includes(o.state)) {
          throw new Error("--state must be one of: processing, delivered, closed (the reviewer controls the other states)");
        }
        review = await setReviewState(dir, o.state as "processing" | "delivered" | "closed", { nextVideo: o.nextVideo ? path.resolve(o.nextVideo) : undefined, force: o.force });
      }
      if (o.json) return printJson({ review, counts: await countComments(dir) });
      out(`${review.id} state=${review.state} round=${review.round}${review.nextVideo ? ` next=${review.nextVideo}` : ""}`);
    }),
  );

program
  .command("carry")
  .argument("<fromVideo>", "previous version")
  .argument("<toVideo>", "new version (its review is created if needed)")
  .description("copy comments from a previous version's review for verification")
  .action(
    action(async (from: string, to: string) => {
      const fromDir = await existingReviewDir(from);
      const { dir: toDir } = await prepareReview(to, { carry: false });
      const carried = await carryComments(fromDir, toDir);
      out(`carried ${carried.length} comment(s) into ${toDir}`);
    }),
  );

program
  .command("export")
  .argument("<target>", "video file or review dir")
  .description("print a summary of the review for the agent (Markdown by default)")
  .option("--format <fmt>", "md | json", "md")
  .action(
    action(async (target: string, o: { format: string }) => {
      if (o.format !== "md" && o.format !== "json") throw new Error("--format must be md or json");
      process.stdout.write(await exportReview(await existingReviewDir(target), o.format));
    }),
  );

program
  .command("timeline")
  .argument("<videoOrEdl>", "a video (sidecar / edl.json next to it) or an edl.json")
  .description("print the timeline Frameback would show for a video")
  .option("--json", "print the timeline JSON")
  .action(
    action(async (arg: string, o: { json?: boolean }) => {
      const abs = path.resolve(arg);
      const isEdl = path.extname(abs) === ".json";
      const video = isEdl ? null : await probeVideo(abs);
      const resolved = isEdl
        ? await edlToTimeline(abs).then(({ timeline, warnings }) => ({ timeline, origin: "edl", sourceFile: abs, approximate: true, warnings }))
        : await resolveTimeline(abs, { videoDuration: video?.duration });
      if (!resolved) throw new Error(`no timeline found for ${abs} (expected <stem>.timeline.json or edl.json next to it)`);
      if (o.json) return printJson(resolved);
      printTimeline(resolved.timeline, resolved.origin, resolved.approximate, resolved.warnings);
    }),
  );

function printTimeline(timeline: Timeline, origin: string, approximate: boolean | undefined, warnings: string[] | undefined) {
  out(`timeline from ${origin}${approximate ? " (approximate)" : ""}${timeline.duration != null ? ` · ${timeline.duration.toFixed(2)}s` : ""}`);
  for (const t of timeline.tracks) out(`  ${t.id.padEnd(12)} ${String(t.items.length).padStart(5)} ${t.kind === "markers" ? "markers" : "segments"}  ${t.label}`);
  for (const w of warnings ?? []) out(`warning: ${w}`);
}

program
  .command("mcp")
  .description("run the MCP server over stdio (for agents that speak MCP)")
  .option("--root <dir>", "default directory to search for reviews", process.cwd())
  .action(
    action(async (o: { root: string }) => {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer({ root: path.resolve(o.root) });
    }),
  );

const skill = program.command("skill").description("agent skill helpers");
skill
  .command("install")
  .description("copy the frameback-review skill into a Claude Code skills directory")
  .option("--dest <dir>", "skills directory", path.join(os.homedir(), ".claude", "skills"))
  .action(
    action(async (o: { dest: string }) => {
      const source = path.join(packageRoot, "skills", "frameback-review");
      if (!(await fs.stat(source).catch(() => null))?.isDirectory()) {
        throw new Error(`skill files not found at ${source}`);
      }
      const target = path.join(path.resolve(o.dest), "frameback-review");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(source, target, { recursive: true });
      out(`installed ${target}`);
    }),
  );

await program.parseAsync(process.argv);
