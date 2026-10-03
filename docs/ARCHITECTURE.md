# TokenTap — Architecture & Design Rationale

## Design Goals

| Goal | How |
|------|-----|
| **Zero dependencies** | Pure Node.js `http` module; no `express`, no `dotenv`, no `http-proxy`. |
| **Single file** | The entire proxy is `bin/tokentap.js` (~290 lines). Easy to audit. |
| **Streaming / SSE-safe** | Responses are piped, never buffered. Server-Sent Events stream intact. |
| **Fail-open** | Unparseable or non-JSON bodies are forwarded unchanged. The proxy never breaks a request it can't understand. |
| **No secrets touched** | API keys live in headers and pass through untouched. TokenTap never reads, logs, or stores them. |
| **Observable** | Health endpoint exposes uptime, config, and per-model request/cap stats. |

## Data Flow

```
                       ┌─ GET /health ────────────────────► (handled locally, returns JSON stats)
                       │
Client ──request──► ┌──┴───────────────────────────────────────────┐
                    │  TokenTap HTTP server (http.createServer)      │
                    │                                               │
                    │  1. Buffer request body (req 'data'/'end')    │
                    │  2. If Content-Type is application/json:       │
                    │       parse → check max_tokens                 │
                    │       resolveCap(model) → model-rule or default│
                    │       if max_tokens > cap: rewrite + re-serialize│
                    │  3. Update Host + Content-Length headers       │
                    │  4. http.request() to TARGET_HOST:TARGET_PORT  │
                    │  5. pipe(proxyRes → res)  ← streaming passthrough│
                    └───────────────────────────────────────────────┘
                                          │
                                          ▼
                              Upstream Gateway / API
```

## Key Design Decisions

### 1. Buffer-then-forward (not pure streaming)

The request body is fully buffered before forwarding because we need to parse
the JSON, possibly rewrite `max_tokens`, re-serialize, and recompute
`Content-Length`. This is unavoidable for body mutation.

The **response** is never buffered — `proxyRes.pipe(res)` streams it directly,
which is critical for SSE (streaming) responses that Claude Code relies on.

**Trade-off**: request bodies must fit in memory. In practice LLM request
payloads are well under 1 MB (images are base64-encoded but bounded). This is
not a concern for the intended use case.

### 2. Substring model matching

`MODEL_CAPS=glm:16384` matches any model whose name *contains* `glm`
(case-insensitive): `glm-5.2`, `glm-4-flash`, `GLM-Plus`, etc.

**Why substring and not exact match?** Model names are messy and versioned
(`qwen3-235b-a22b-instruct`). Exact matching would require maintaining a
catalog. Substring matching on a family prefix (`glm`, `qwen3`, `llama3`) is
robust across version bumps. The first matching rule wins (declaration order).

### 3. Built-in .env parser (15 lines)

Adding `dotenv` would be the only dependency in the project. A tiny inline
parser handles the common cases (KEY=VALUE, quotes, comments) and keeps the
"zero dependencies" promise. Real environment variables always override `.env`
values.

### 4. Health endpoint never forwarded

`GET /health` is intercepted locally and returns a JSON snapshot. It is **not**
sent upstream. This lets you monitor TokenTap itself (is it running? how many
requests has it capped?) independently of the upstream's health.

### 5. Graceful shutdown

On `SIGINT`/`SIGTERM`, TokenTap stops accepting new connections and waits up to
5 seconds for in-flight requests to finish, then exits. This prevents dropped
SSE streams when restarting.

## What TokenTap Does NOT Do

- **No TLS termination.** Use a reverse proxy (nginx, Caddy) in front for HTTPS.
- **No authentication.** It trusts whatever the client sends. Bind to
  `127.0.0.1` or put it behind a firewall.
- **No request/response logging to disk.** Only console logging at configurable
  levels. Bodies are never logged.
- **No rate limiting, caching, or load balancing.** It is a single-purpose
  shim, not a gateway.

## Security Model

```
   ┌──────────────────────────────────────────────────────┐
   │  TokenTap trust boundary                              │
   │                                                       │
   │  • Reads:  request JSON body (max_tokens, model)      │
   │  • Writes: max_tokens field only                      │
   │  • Passes through: all headers (incl. API keys)       │
   │  • Never logs:  header values, body contents           │
   │  • Never stores: anything to disk                     │
   │                                                       │
   │  Default bind: 127.0.0.1 (localhost only)             │
   └──────────────────────────────────────────────────────┘
```

The `.env` file (which may contain no secrets itself but is the conventional
location for them) is git-ignored. The `.gitignore` also blocks `.pem`, `.key`,
`secrets/`, `credentials/`, and any file matching `*token*`.

## Extension Points

The `resolveCap(model)` function is the single place where the capping policy
lives. To add smarter logic (e.g., caps from a remote API, dynamic limits based
on time of day), replace that function — the rest of the pipeline is generic.
