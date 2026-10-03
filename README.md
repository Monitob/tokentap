# TokenTap 🚰

> A zero-dependency reverse proxy that caps `max_tokens` in LLM API requests,
> so models with lower output-token limits stop getting rejected.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-green.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-blue.svg)](CONTRIBUTING.md)

---

## The Problem

Many LLM clients (Claude Code, OpenAI SDKs, custom scripts) send a default
`max_tokens` of **128 000** or more. When you point them at a self-hosted or
third-party model whose provider caps output tokens lower (e.g. Scaleway's
`glm-5.2` at **16 384**), the request is **rejected outright** with a 400 error:

```
{"error":{"type":"invalid_request_error","message":"max_tokens: 128000 > 16384"}}
```

You then have to hunt down every client's config and lower the value manually.
**TokenTap fixes this transparently** — it sits between your client and the
upstream API, rewrites `max_tokens` down to a safe value, and forwards the
request. Your client never knows the difference.

## How It Works

```
   Client (Claude Code, curl, SDK, …)
      │  POST /v1/messages  { "max_tokens": 128000, ... }
      ▼
 ┌──────────────────────────────────────────────┐
 │  TokenTap  (:3459)                            │
 │  • parses JSON body                           │
 │  • caps max_tokens → 16384 (or per-model)     │
 │  • rewrites content-length                    │
 │  • streams response back (SSE-safe)           │
 └──────────────────────────────────────────────┘
      │  POST /v1/messages  { "max_tokens": 16384, ... }
      ▼
   Upstream Gateway / API   (e.g. 127.0.0.1:3456)
```

TokenTap is **not** a full API gateway. It is a focused, single-purpose shim
that does one job well: keeping `max_tokens` within a model's limits.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Monitob/tokentap.git
cd tokentap

# 2. Configure (copy the template — .env is git-ignored)
cp .env.example .env
#   edit .env: set TARGET_PORT to your upstream, MAX_TOKENS_CAP, etc.

# 3. Run (no install needed — zero dependencies!)
node bin/tokentap.js
```

You should see:

```
[2026-01-15T10:30:00.000Z] [INFO] TokenTap listening on http://127.0.0.1:3459
[2026-01-15T10:30:00.000Z] [INFO]   → forwarding to 127.0.0.1:3456
[2026-01-15T10:30:00.000Z] [INFO]   → default max_tokens cap: 16384
[2026-01-15T10:30:00.000Z] [INFO]   → health check: http://127.0.0.1:3459/health
```

Now point your client at `http://127.0.0.1:3459` instead of the upstream directly.

### Even faster — `npx` / global

```bash
# Run on the fly (once published to npm)
npx tokentap

# Or install globally
npm install -g tokentap
tokentap
```

## Configuration

All settings come from **environment variables** or a `.env` file in the
working directory. Real environment variables always win over `.env`.

| Variable          | Default     | Description                                              |
|-------------------|-------------|----------------------------------------------------------|
| `PORT`            | `3459`      | Port TokenTap listens on (clients connect here)          |
| `HOST`            | `127.0.0.1` | Bind address (`0.0.0.0` = all interfaces)               |
| `TARGET_HOST`     | `127.0.0.1` | Upstream host to forward to                             |
| `TARGET_PORT`     | `3456`      | Upstream port to forward to                             |
| `MAX_TOKENS_CAP`  | `16384`     | Default cap when no per-model rule matches              |
| `MODEL_CAPS`      | *(empty)*   | Per-model caps, comma-separated (see below)              |
| `LOG_LEVEL`       | `info`      | `none` · `error` · `info` · `debug`                     |
| `HEALTH_PATH`     | `/health`   | Path for the health-check endpoint                       |

### Per-Model Caps

Different models have different limits. `MODEL_CAPS` lets you set a cap per
model (or model family). Names are matched **case-insensitively as substrings**
of the request's `model` field:

```bash
# .env
MODEL_CAPS=glm:16384,qwen3:32768,llama3:8192
```

| Request `model`      | Matched rule | Effective cap |
|----------------------|--------------|---------------|
| `glm-5.2`            | `glm`        | `16384`       |
| `qwen3-235b-a22b`    | `qwen3`      | `32768`       |
| `llama3.1-70b`       | `llama3`     | `8192`        |
| `deepseek-r1`        | *(none)*     | `16384` (default) |

If no model rule matches, `MAX_TOKENS_CAP` is used as the fallback.

## Usage Examples

### With Claude Code

Point Claude Code's `ANTHROPIC_BASE_URL` at TokenTap instead of the gateway
directly:

```bash
# In your shell / settings
export ANTHROPIC_BASE_URL=http://127.0.0.1:3459
export ANTHROPIC_API_KEY=sk-your-key      # forwarded untouched
claude -p "Hello, are you there?"
```

### With `curl`

```bash
curl http://127.0.0.1:3459/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: sk-your-key" \
  -d '{
    "model": "glm-5.2",
    "max_tokens": 128000,
    "messages": [{"role":"user","content":"Say hi"}]
  }'
```

TokenTap logs: `Capping max_tokens 128000 → 16384 [model-rule(glm)] …`

### Health Check

```bash
curl http://127.0.0.1:3459/health | jq .
```

```json
{
  "status": "ok",
  "uptime_seconds": 342,
  "target": "127.0.0.1:3456",
  "max_tokens_cap": 16384,
  "model_caps": { "glm": 16384 },
  "stats": {
    "requestsTotal": 42,
    "requestsCapped": 38,
    "byModel": { "glm-5.2": { "total": 42, "capped": 38 } }
  }
}
```

## Deployment

### systemd (Linux)

```ini
# /etc/systemd/system/tokentap.service
[Unit]
Description=TokenTap LLM max_tokens proxy
After=network.target

[Service]
Type=simple
User=tokentap
WorkingDirectory=/opt/tokentap
EnvironmentFile=/opt/tokentap/.env
ExecStart=/usr/bin/node /opt/tokentap/bin/tokentap.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tokentap
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY bin/ bin/
COPY package.json ./
# No npm install — zero dependencies!
ENV HOST=0.0.0.0 PORT=3459
EXPOSE 3459
CMD ["node", "bin/tokentap.js"]
```

```bash
docker build -t tokentap .
docker run -d -p 3459:3459 \
  -e TARGET_HOST=host.docker.internal \
  -e TARGET_PORT=3456 \
  -e MAX_TOKENS_CAP=16384 \
  tokentap
```

### Background process (quick & dirty)

```bash
nohup node bin/tokentap.js > tokentap.log 2>&1 &
```

## Development

```bash
# Debug mode (logs every pass-through, not just caps)
npm run dev
# or: LOG_LEVEL=debug node bin/tokentap.js

# Check health
npm run health
```

The entire codebase is a **single file**: [`bin/tokentap.js`](bin/tokentap.js).
Read it end-to-end in ~5 minutes. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the design rationale.

### Project Structure

```
tokentap/
├── bin/
│   └── tokentap.js      # The proxy — the whole product, ~290 lines
├── docs/
│   └── ARCHITECTURE.md  # Design rationale & data flow
├── .env.example         # Template config (real .env is git-ignored)
├── .gitignore           # Secrets, logs, node_modules, OS/IDE files
├── LICENSE              # MIT
├── package.json
└── README.md
```

## Roadmap

- [x] Global `max_tokens` cap
- [x] Per-model caps
- [x] Health check + stats
- [x] Graceful shutdown
- [ ] HTTPS/TLS termination
- [ ] Optional request/response logging to file
- [ ] Config file (JSON/YAML) in addition to env vars
- [ ] Prometheus metrics endpoint
- [ ] Generic field-rewrite rules (not just `max_tokens`)

## Security Notes

- TokenTap **binds to `127.0.0.1` by default**. Only set `HOST=0.0.0.0` if you
  understand the exposure and are behind a firewall/VPN.
- It does **not** store, log, or transmit API keys — they pass through untouched
  in headers.
- The `.env` file is git-ignored. **Never** commit real credentials.
- Non-JSON and unparseable bodies are forwarded unchanged (fail-open).

## License

MIT © [Monitob](https://github.com/Monitob) — see [LICENSE](LICENSE).

