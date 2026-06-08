# Platform policies you must understand

This is the detail behind the short list in the [README](./README.md). It
describes exactly how coders.kr treats your app at runtime — identity,
metering, quotas, and (the part that bites people) long-lived connections
like WebSockets. Read the WebSocket section before you ship anything that
streams.

> These are *platform* behaviours, not template code. They apply to any
> app running in `mode: native` on coders.kr, template-coders or not.

---

## 1. Identity & the gate

Every tenant runs behind a per-site **gate** (a reverse proxy the platform
puts in front of your public service). Before a request reaches your code
the gate has already:

1. Read and verified the visitor's `coders_session` cookie at the edge.
2. **Stripped** any client-supplied `X-Coders-User` header (so it can't be
   spoofed), then **set** `X-Coders-User: <uuid>` if the session was valid.
3. Decided, by HTTP method, whether an anonymous visitor is even allowed
   through (see §2).
4. Metered the request against the right quota bucket (see §3–4).

In your code:

- **Trust `X-Coders-User`.** If it's present, it's a real validated visitor.
  If it's absent, the visitor is anonymous.
- **Never build your own OAuth.** Link to
  `https://mcp.coders.kr/sso/login?return_to=<your-url>` to sign in and
  `https://mcp.coders.kr/sso/logout?return_to=<your-url>` to sign out.
- The visitor UUID is **pairwise per project** — the same person has a
  different `X-Coders-User` on a different site. Use it as a stable local
  key (`coders_id`), not as a global identity.

---

## 2. Method gating (native mode)

The gate treats HTTP methods as a read/write convention:

| Method | Anonymous visitor |
|---|---|
| `GET` / `HEAD` / `OPTIONS` (safe) | allowed through (metered) |
| `POST` / `PUT` / `PATCH` / `DELETE` | **302 → sign-in page** before reaching you |

So in native mode you get "reads are public, writes require a logged-in
user" for free — **use `POST` for anything that needs identity** and you'll
always have an `X-Coders-User` when the handler runs.

This is a *convenience*, not your security boundary. The real authorization
still happens in your app/DB (the gate only knows the HTTP method, not what
your handler does). Check `X-Coders-User` yourself before any sensitive
action.

---

## 3. The cost model (how a request is priced)

Every request that reaches your app costs **cost-units (micros)**, deducted
from one quota pool. The formula (per request):

```
cost = 100  +  ( duration_ms × 1  +  (response_bytes ÷ 1024) × 10 )  ÷  concurrency
        ^BASE         ^1 micro per ms        ^10 micros per KB out      ^in-flight requests
```

- **BASE = 100** micros — fixed per-request overhead.
- **+1 micro per millisecond** the request is open. This is the big one for
  anything slow or streaming.
- **+10 micros per KB** of response body.
- **÷ concurrency** — the variable part is divided by how many requests the
  pod is serving at that instant (pod-time is what the platform actually
  pays for, so 100 concurrent requests don't bill 100× a single one).

Rules of thumb:

- A snappy JSON `GET` (~50 ms, a few KB) ≈ **~200 micros**.
- A 1-second request ≈ **~1,100 micros**.
- **A connection held open for 60 seconds ≈ ~60,000 micros** (see §5 — this
  is why WebSockets need care).

Static assets (JS/CSS/images) served with cache headers are fronted by
Cloudflare and **don't hit your pod**, so they cost nothing. Lean on the CDN.

---

## 4. Quota pools & what happens when one empties

The gate routes each request to one pool, in this order:

| Visitor | Pool | Default size | When it empties |
|---|---|---|---|
| **Anonymous** | `ProjectQuota` (one per *site*, per month) | **3,000,000** micros | **every anonymous request → 302 sign-in** ("sign in to keep browsing") |
| **Signed-in (not you)** | `UserProjectQuota` (per *visitor × site*, per month) | **300,000** micros | then falls through to ↓ |
| **Signed-in, paid** | `UserQuota` (per *visitor*, paid balance) | 0 until they top up | **gated page** ("upgrade your coders.kr subscription") |
| **You, the owner** | — exempt — | unlimited, unmetered | never |

Two consequences worth internalizing:

- **When your site's anonymous pool runs out, *all anonymous traffic* is
  redirected to sign-in for the rest of the month.** That's intended (it
  pushes heavy anonymous use toward an identified, separately-budgeted
  user) — but it means a single runaway cost source can effectively wall
  off your whole public site. Watch what anonymous visitors can make
  expensive.
- The signed-in **per-site pool is only 300,000 micros** — small. A normal
  app (short requests) is fine for thousands of requests; a streaming app
  burns it in minutes (see §5).

You, deploying your own site, are never metered — so **everything feels free
while you test.** Cost only shows up with real anonymous/other-user traffic.

---

## 5. WebSockets, SSE & long-lived connections — read this

WebSockets work through the gate, but the runtime is a scale-to-zero,
Spot-node, rolling-deploy platform, and the cost model prices by time. Three
things follow.

### 5a. Raise `timeout`, but expect disconnects anyway

Knative treats a WebSocket (or SSE / long-poll) as **one long-lived
request**, capped by the service's request timeout — **default 300 s**. For
realtime apps, set `timeout` (seconds, up to 3600) on every service the
socket passes through in `coders.yaml`:

```yaml
services:
  web:
    ...
    timeout: 3600   # if the socket terminates here
  api:
    ...
    timeout: 3600   # and/or here
```

But **connections are not durable regardless of `timeout`.** Spot-node
preemption, a redeploy rolling the revision, and idle scale-down all drop
open sockets. **Implement client reconnect with backoff** and resume state
on reconnect — treat a dropped socket as normal, not exceptional. (App-level
WebSocket ping/pong passes through the gate transparently and helps keep
intermediaries from closing an otherwise-quiet connection.)

### 5b. A long connection bills continuously — and can wall off your site

Because cost is **~1 micro per millisecond open**, an open connection bills
about **60,000 micros per minute** (÷ concurrency). Compare that to the
pools in §4:

| Pool | Size | ≈ minutes of one open socket |
|---|---|---|
| Anonymous (whole site) | 3,000,000 | **~50 min** |
| Signed-in per-site | 300,000 | **~5 min** |

So **one anonymous WebSocket left open drains your entire site's anonymous
pool in under an hour** — after which *every* anonymous request 302s to
sign-in (§4). This is the single most common way to take a site down by
accident.

Design around it:

- **Don't hold anonymous sockets open.** Require sign-in *before* opening a
  long-lived connection (open the socket only after you have an
  `X-Coders-User`), so its cost lands on that user's pool, not the shared
  anonymous one.
- Even signed-in, the per-site pool is ~5 socket-minutes — heavy realtime
  use needs the user to have a paid balance, or it'll gate. Budget for it.
- Keep sockets idle-cheap but short; reconnect on demand rather than holding
  a channel open for hours.
- A background **daemon/agent that holds a socket open continuously must be
  authenticated** (send the `coders_session` cookie), or it will silently
  drain the anonymous pool.

### 5c. The gate can't see inside a socket — authorize messages yourself

The method gate (§2) only applies to the HTTP handshake, which is a `GET`.
Once the socket is open, the gate sees no individual messages, so it can't
enforce read/write rules on them. The gate **does** stamp `X-Coders-User` on
the handshake (empty if anonymous). **Authorize every state-changing message
in your own handler** against that identity — the platform won't do it for
you on a socket.

---

## 6. Cold start

Tenant services **scale to zero** when idle, so the first request after a
quiet period pays a cold start. Keep it short:

- **Build at image-build time, not container-start time.** Don't run
  `npm install` / `pip install` / migrations in your entrypoint — bake them
  into the Docker image. A slow entrypoint turns every cold start into a
  multi-second stall (and can trip readiness).
- Run DB migrations as a one-shot step, not on every boot.

(An open WebSocket keeps the pod warm — which is good for latency but is
exactly the cost in §5. Pick deliberately.)

---

## 7. Modes

- **`mode: native`** (this template): the gate does identity + method gating
  as above. Zero auth code in your app; trust `X-Coders-User`.
- **`mode: standalone`**: the gate touches neither identity nor method —
  all traffic counts against the anonymous pool and your app brings its own
  login. Use only if you're porting an app that already has OAuth. See the
  platform's [PLATFORM.md](https://github.com/cykim8811/coders-platform/blob/main/PLATFORM.md).

---

## 8. Managed LLM (Claude) — no API key of your own

Declare a `type: llm` component and the platform gives you a working Claude
endpoint with **no Anthropic key of your own**. The platform injects its key,
and **bills each call's exact tokens to the visitor's pool** — same per-visitor
economics as everything else.

```yaml
# coders.yaml
services:
  api:
    dockerfile: backend/Dockerfile
    env:
      ANTHROPIC_BASE_URL: ${ai.url}     # the platform LLM proxy
      ANTHROPIC_API_KEY:  ${ai.token}   # per-tenant token — NOT a real key

  ai:
    type: llm
    # Allow-list. Default is the cheaper tier; list Opus to opt in.
    models: [claude-sonnet-4-6, claude-haiku-4-5]
    default_model: claude-sonnet-4-6
```

Use the **stock Anthropic SDK** unchanged — only `base_url`/`api_key` come from
env. Streaming, tools, thinking, and prompt caching all pass through.

### You MUST forward `X-Coders-User` on each call

The proxy bills the **visitor**, but your server-side LLM call doesn't carry the
visitor's identity unless you pass it. Forward the `X-Coders-User` header you
received on the incoming request as `x-coders-user` on the Anthropic call.
**If you don't, the call is billed to the project's anonymous pool** (and one
chat can drain it — see below).

```python
# backend: forward the caller's identity so cost lands on THEIR pool
from anthropic import AsyncAnthropic
client = AsyncAnthropic()  # base_url + api_key from env

async def reply(prompt: str, coders_user):           # coders_user from identity dep
    msg = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
        extra_headers={"x-coders-user": str(coders_user)} if coders_user else {},
    )
    return msg.content[0].text
```

### Cost reality

LLM tokens are **far** more expensive than page compute. One Sonnet turn
(~1K in + 1K out) ≈ 21,600 micros — so the $3 anonymous pool buys only ~140
turns, the $0.30 per-user-per-site pool ~6. This is by design: the per-visitor
pool is what bounds spend. Plan for it — gate expensive generation behind
sign-in, keep prompts/outputs tight, and lean on prompt caching (cache-reads
are billed at 1/10th). The proxy clamps `max_tokens` to 16,000 per request.

---

## 9. `coders.yaml` is a strict contract — exact fields only

The platform validates your `coders.yaml` against a fixed schema and
**rejects any key it doesn't recognise**. A typo or a field from some
other tool's config (`build:`, `public:`, `scale:`, `resources:`,
`needs:`, `release:`, `health:`, `version:` on a service, …) **fails the
deploy** with the offending field named — it is not silently ignored. If
a deploy errors with `Extra inputs are not permitted`, delete that key.

The complete accepted shape (everything else is an error):

```yaml
version: "1"            # optional, default "1"
mode: native            # optional: native | standalone (default native)

services:               # required, ≥1 entry; each is a build OR a component
  <name>:               # ---- buildable service ----
    dockerfile: path/to/Dockerfile   # required (relative to repo root)
    context: .                       # optional, default "."
    port: 8080                       # optional, default 8080
    expose: internal                 # optional: public | internal (default internal)
    timeout: 300                     # optional seconds, 1–3600 (default 300)
    env:                             # optional, ${...}-substituted
      KEY: value

  <name>:                            # ---- managed component (no build) ----
    type: postgres                   # exposes ${<name>.host/port/user/password/name/url}
    size: 1Gi                        #   optional, 512Mi–10Gi (advisory)
  <name>:
    type: redis                      # exposes ${<name>.host/port/url}
  <name>:
    type: object                     # exposes ${<name>.bucket/region/endpoint/public_url}
    quota_gb: 1                      #   optional, 1–50
  <name>:
    type: llm                        # exposes ${<name>.url/token} — see §8
    models: [claude-sonnet-4-6, claude-haiku-4-5]   # optional allow-list
    default_model: claude-sonnet-4-6                # optional, must be in models
```

Cross-field rules the validator also enforces:

- **Exactly one** buildable service may set `expose: public` (that's your
  site at `<project>.coders.kr`).
- **At most one** `object` component and **at most one** `llm` component.

The canonical machine-readable schema lives at
[`schema/coders.schema.json`](https://github.com/cykim8811/coders-platform/blob/main/schema/coders.schema.json)
in the platform repo (point your editor's YAML LSP at it for inline
validation), and a worked example is at
[`examples/coders.yaml`](https://github.com/cykim8811/coders-platform/blob/main/examples/coders.yaml).

---

## TL;DR

- Trust `X-Coders-User`; never build login; link to `mcp.coders.kr/sso/*`.
- `GET` = anonymous-OK, `POST` = auto-requires login.
- Cost per request ≈ `100 + duration_ms + (KB_out × 10)`, with the variable
  part divided by concurrency; static assets are free via the CDN.
- Anonymous pool empty → **all anonymous traffic 302s to sign-in** for the
  month. Per-user-per-site pool is small (300k).
- **WebSockets bill ~60k micros/min.** One open *anonymous* socket kills your
  anonymous pool in ~50 min. Authenticate before opening long sockets, set
  `timeout`, and reconnect on drop.
- **Managed LLM** (`type: llm`): no key of your own; forward `X-Coders-User` on
  every Claude call or it bills the anonymous pool. Tokens are the priciest
  axis — a $3 pool ≈ 140 Sonnet turns.
- Build at image time so cold starts stay fast.
- **`coders.yaml` is strict** — only the documented fields (§9) are
  allowed; an unknown key fails the deploy. Don't invent fields.
- **Hit friction deploying? File it** at the public tracker:
  `gh issue create --repo cykim8811/coders-feedback ...` (any error you worked
  around, confusing message, doc that didn't match reality — whether it's your
  mistake, the platform's, or this template's; the maintainers triage, don't
  self-censor). No `gh`? Use the `report_issue` MCP tool as a fallback.
