# Security policy

## Threat model

Frameback is a local tool for a single reviewer.

- By default the server binds to `127.0.0.1` only (see "Share mode" below for the opt-in exception) and rejects requests whose `Host` or `Origin` is not local.
- It serves only the video files you registered (by opening them) and the review data next to them. Other paths are
  refused, and paths are checked against traversal.
- Review data is plain files in `review/<stem>/` next to each video, stored with relative paths. There is no telemetry,
  no account and no outbound network access, except the opt-in webhook push
  (`FRAMEBACK_WEBHOOK_URL`): when set, human events are POSTed to the URL you configured, nowhere else.
- Anything that can write to a `review/` folder or call the local server can act as the reviewer or the agent. Do not
  expose the port beyond localhost. In Docker the server listens on `0.0.0.0` inside the container; publish the port on
  `127.0.0.1` only (the provided compose file does). Frameback warns on stderr when `FRAMEBACK_BIND` is not loopback.

## Share mode (`frameback open --share [tailscale]`)

Opt-in, for reviewing from another computer over Tailscale or a private wifi/LAN. Without `--share` none of this
applies and the server behaves exactly as described above.

**Whoever has the link can review, and nothing else.**

| A person with the link can | A person with the link cannot |
|---|---|
| Open the review(s) already open on this server and watch their video (including the "next version" the agent delivered) | Register a video or send any file path (`POST /api/reviews` is 403), so no other file on the disk can be read |
| See the timeline, waveform and live events | Call `video-info`, `/api/share`, `/api/health` or any route not in the allowlist (403) |
| Add, edit and delete comments, replies and snapshots; submit and reopen the review | See absolute paths of this machine (`reviewDir` is left out, error messages are redacted) |
| | Keep access after the link expires (12 h by default) or after the process exits |

How it is enforced:

- **Trusted local client.** Only a request whose socket is loopback **and** whose `Host` is `localhost`/`127.0.0.1`/`[::1]`
  **and** that carries no `X-Forwarded-For`/`Forwarded` header skips the key. Anything else, including requests relayed by
  a reverse proxy on this machine (`tailscale serve`, nginx…), is treated as remote.
- **Key.** A random key (192 bits, regenerated on every start) is part of the link and is the only credential:
  `?key=` once (answered with an HttpOnly, SameSite=Lax cookie and a redirect that removes the key from the URL), then
  the cookie. It is `Lax`, not `Strict`: a `Strict` cookie is not sent after a cross-site redirect, so a link opened from
  messaging or email would get 401. State changes (POST/PATCH/PUT/DELETE) stay protected by the foreign-`Origin` check,
  which browsers always send on cross-site writes, and the only remote GET with a side effect (`/media/:rid/next`) never
  takes a path from the peer. Keys are compared in constant time. The key is printed only on the command's stdout; it is never written to
  `review/`, events or logs.
- **Allowlist.** Remote requests may only reach the review routes listed in `src/server/share.ts` (`remoteAllowed`);
  everything else is 403. `GET /media/:rid/next` is allowed because it registers the path the local agent wrote in
  `review.json`, never a path sent by the peer.
- **Expiry.** The key stops working after 12 hours (`--share-ttl <hours>`, max 24); then remote requests get 401 and a
  notice is printed on stderr. The local UI keeps working. A new run makes a new link. The cookie's `Max-Age` matches.
- **Interfaces.** The server listens on 127.0.0.1 plus this machine's private addresses only (RFC 1918 and
  100.64.0.0/10, Tailscale's range), never on `0.0.0.0` or a public address, and refuses requests that arrive on any other
  local address. `--share tailscale` listens only on loopback and the Tailscale addresses.
- **Host and Origin.** The `Host` guard accepts loopback plus this machine's own names/addresses for the selected mode;
  any other `Host` is rejected (DNS rebinding). `Origin` must match `Host`.
- **Brute force.** 20 failed key attempts per minute from one address answer 429 for the rest of that minute.
- Remote responses are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

Transport: Tailscale traffic is encrypted end to end by Tailscale. Local network links are plain HTTP: anyone on the same
wifi can read the key and the video. Use them only on a network you trust (home/office), and `--share tailscale` anywhere
else.

Out of scope: HTTPS, accounts, exposure to the open internet, a peer who already has the link (it is a bearer
credential: treat it like a password), and IPv6 link-local addresses.

## Reporting a vulnerability

Please report privately, not in a public issue: use GitHub private vulnerability reporting on the repository
(Security tab, "Report a vulnerability"), or email
[hello@guillebecerrao.cl](mailto:hello@guillebecerrao.cl). Include the Frameback and Node versions and steps to reproduce. Expect a
first reply within a few days.
