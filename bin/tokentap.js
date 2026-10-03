#!/usr/bin/env node
/**
 * TokenTap — a lightweight reverse proxy that caps `max_tokens` in LLM API
 * requests so that models with lower output-token limits are not rejected
 * by their providers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  Zero dependencies · Pure Node.js · Streaming (SSE-safe)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Flow:
 *
 *   Client (Claude Code, curl, SDK, …)
 *      │  POST /v1/messages  { "max_tokens": 128000, ... }
 *      ▼
 *   TokenTap  (:PORT)          ← intercepts & caps max_tokens
 *      │  POST /v1/messages  { "max_tokens": 16384, ... }
 *      ▼
 *   Upstream Gateway / API     (TARGET_HOST:TARGET_PORT)
 *
 * Config priority:
 *   1. Real environment variables (always win)
 *   2. A `.env` file in the working directory (tiny built-in parser)
 *
 * Env vars:
 *   PORT             Listen port                        (default 3459)
 *   HOST             Listen host                        (default 127.0.0.1)
 *   TARGET_HOST      Upstream host                      (default 127.0.0.1)
 *   TARGET_PORT      Upstream port                      (default 3456)
 *   MAX_TOKENS_CAP   Default cap when no model rule     (default 16384)
 *   MODEL_CAPS       Per-model caps, comma-separated    (default "")
 *                    e.g. "glm-5.2:16384,qwen3-235b:32768"
 *   LOG_LEVEL        none | error | info | debug        (default info)
 *   HEALTH_PATH      Path for the health-check endpoint (default /health)
 *
 * License: MIT
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Tiny .env loader (no external dependency) ──────────────────────────────
function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // No .env file — that's fine, rely on real env vars.
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes: KEY="value"  → value
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Real environment variables always take precedence over .env.
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

// ─── Config ────────────────────────────────────────────────────────────────
const HOST           = process.env.HOST || '127.0.0.1';
const PORT           = parseInt(process.env.PORT || '3459', 10);
const TARGET_HOST    = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT    = parseInt(process.env.TARGET_PORT || '3456', 10);
const MAX_TOKENS_CAP = parseInt(process.env.MAX_TOKENS_CAP || '16384', 10);
const HEALTH_PATH    = process.env.HEALTH_PATH || '/health';
const LOG_LEVEL      = (process.env.LOG_LEVEL || 'info').toLowerCase();

/**
 * Parse MODEL_CAPS="modelA:1234,modelB:5678" into a Map.
 * Model names are matched case-insensitively as substrings of the request's
 * `model` field, so "glm" matches "glm-5.2", "glm-4-flash", etc.
 */
function parseModelCaps(raw) {
  const caps = new Map();
  if (!raw) return caps;
  for (const entry of raw.split(',')) {
    const part = entry.trim();
    if (!part) continue;
    const colon = part.lastIndexOf(':');
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const cap  = parseInt(part.slice(colon + 1).trim(), 10);
    if (name && Number.isFinite(cap) && cap > 0) {
      caps.set(name, cap);
    }
  }
  return caps;
}
const MODEL_CAPS = parseModelCaps(process.env.MODEL_CAPS || '');

// ─── Logging ───────────────────────────────────────────────────────────────
const LEVELS = { none: 0, error: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}
function log(level, msg) {
  if ((LEVELS[level] ?? 0) <= CURRENT_LEVEL) {
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`[${ts()}] [${level.toUpperCase()}] ${msg}\n`);
  }
}

// ─── Stats ─────────────────────────────────────────────────────────────────
const stats = {
  startedAt: Date.now(),
  requestsTotal: 0,
  requestsCapped: 0,
  byModel: {}, // model -> { total, capped }
};

function bumpStats(model, capped) {
  stats.requestsTotal++;
  if (capped) stats.requestsCapped++;
  if (model) {
    if (!stats.byModel[model]) stats.byModel[model] = { total: 0, capped: 0 };
    stats.byModel[model].total++;
    if (capped) stats.byModel[model].capped++;
  }
}

// ─── Resolve the effective cap for a given model ───────────────────────────
function resolveCap(model) {
  if (model && MODEL_CAPS.size > 0) {
    const lower = String(model).toLowerCase();
    for (const [name, cap] of MODEL_CAPS) {
      if (lower.includes(name)) {
        return { cap, source: `model-rule(${name})` };
      }
    }
  }
  return { cap: MAX_TOKENS_CAP, source: 'default' };
}

// ─── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Health-check endpoint — never forwarded upstream.
  if (req.method === 'GET' && req.url === HEALTH_PATH) {
    const uptimeSec = Math.round((Date.now() - stats.startedAt) / 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime_seconds: uptimeSec,
      target: `${TARGET_HOST}:${TARGET_PORT}`,
      max_tokens_cap: MAX_TOKENS_CAP,
      model_caps: Object.fromEntries(MODEL_CAPS),
      stats,
    }, null, 2));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    let modifiedBody = bodyBuffer;
    let model = null;
    let capped = false;

    // Only touch JSON request bodies (Anthropic /v1/messages, OpenAI /v1/...).
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && bodyBuffer.length > 0) {
      try {
        const json = JSON.parse(bodyBuffer.toString('utf8'));
        model = json.model || null;

        if (typeof json.max_tokens === 'number') {
          const { cap, source } = resolveCap(model);
          if (json.max_tokens > cap) {
            log('info',
              `Capping max_tokens ${json.max_tokens} → ${cap}` +
              ` [${source}] (model: ${model || 'unknown'}, path: ${req.url})`
            );
            json.max_tokens = cap;
            capped = true;
            modifiedBody = Buffer.from(JSON.stringify(json), 'utf8');
          } else {
            log('debug',
              `Pass-through max_tokens=${json.max_tokens}` +
              ` (cap ${cap} via ${source}, model: ${model || 'unknown'})`
            );
          }
        }
      } catch (_e) {
        // Not valid JSON — forward the original body unchanged.
        log('debug', `Non-JSON body on ${req.url}, forwarding as-is`);
      }
    }

    bumpStats(model, capped);

    // Build forwarded headers (update host + content-length).
    const fwdHeaders = { ...req.headers };
    fwdHeaders['host'] = `${TARGET_HOST}:${TARGET_PORT}`;
    fwdHeaders['content-length'] = String(Buffer.byteLength(modifiedBody));

    const proxyReq = http.request(
      {
        hostname: TARGET_HOST,
        port: TARGET_PORT,
        method: req.method,
        path: req.url,
        headers: fwdHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res); // Stream response body (works for SSE / streaming).
      }
    );

    proxyReq.on('error', (err) => {
      log('error', `Upstream error on ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'upstream_unreachable',
            message: `TokenTap could not reach upstream ` +
                     `${TARGET_HOST}:${TARGET_PORT}: ${err.message}`,
          },
        }));
      }
    });

    proxyReq.write(modifiedBody);
    proxyReq.end();
  });

  req.on('error', (err) => {
    log('error', `Request error: ${err.message}`);
  });
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────
function shutdown(signal) {
  log('info', `${signal} received — draining connections…`);
  server.close(() => {
    log('info', 'All connections closed. Bye.');
    process.exit(0);
  });
  // Force-exit after 5s if something hangs.
  setTimeout(() => {
    log('error', 'Forced exit after 5s timeout.');
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ──────────────────────────────────────────────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('error', `Port ${PORT} already in use. Set a different PORT.`);
  } else {
    log('error', `Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log('info', `TokenTap listening on http://${HOST}:${PORT}`);
  log('info', `  → forwarding to ${TARGET_HOST}:${TARGET_PORT}`);
  log('info', `  → default max_tokens cap: ${MAX_TOKENS_CAP}`);
  if (MODEL_CAPS.size > 0) {
    log('info', `  → per-model caps:`);
    for (const [name, cap] of MODEL_CAPS) {
      log('info', `      • ${name} → ${cap}`);
    }
  }
  log('info', `  → health check: http://${HOST}:${PORT}${HEALTH_PATH}`);
  log('info', `  → log level: ${LOG_LEVEL}`);
});
