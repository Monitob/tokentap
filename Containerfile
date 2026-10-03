# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────
# TokenTap — container image (zero runtime dependencies, no npm install)
#
# Works with Podman and Docker. The container forwards to a host-side
# upstream (e.g. Claude Code Router on 127.0.0.1:3456) via host.docker.internal
# — see docker-compose.yml, which adds the host-gateway mapping for Linux.
# ─────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Only what the proxy needs: the entry script + manifest. Zero deps => no install.
COPY package.json ./
COPY bin/ bin/

# Sensible container defaults. Override at run time via environment / compose.
# HOST=0.0.0.0 so the published port actually reaches the proxy.
ENV HOST=0.0.0.0 \
    PORT=3459 \
    TARGET_HOST=host.docker.internal \
    TARGET_PORT=3456 \
    MAX_TOKENS_CAP=16384 \
    MODEL_CAPS= \
    LOG_LEVEL=info \
    HEALTH_PATH=/health

EXPOSE 3459

# Zero-dependency health probe: hits the in-container /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3459/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "bin/tokentap.js"]
