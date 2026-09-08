# ============================================================================
#  LinkVault
#
#  Node 24 is required, not just preferred: the database is Node's built-in
#  node:sqlite, which is only unflagged from 23.4 onwards. On Node 22 it needs
#  --experimental-sqlite and the app will not start without it.
# ============================================================================
FROM node:24-alpine

# tini as PID 1 so SIGTERM reaches the app promptly during a rolling deploy.
# server.js closes the HTTP server on SIGTERM; without a proper init that
# signal can be missed and the platform ends up SIGKILLing mid-write.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first, so a code-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The data directory is where the SQLite file, its WAL, and the dev secret
# cache live. It MUST be a mounted volume in production — see DEPLOY.md.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_FILE=/app/data/linkvault.db

EXPOSE 3000

# Uses the app's own /healthz route, which reports uptime and AdSense state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
