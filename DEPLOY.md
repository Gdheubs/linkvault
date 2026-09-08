# Deploying LinkVault

The app is a single Node process with a SQLite file. There is no build step and no external database. That makes deployment simple, and it makes **the database file the only thing you must back up**.

## 1. Prerequisites

- A server with **Node.js 22.5+** (24 recommended)
- A domain with DNS pointed at it
- TLS — the flow sets `Secure` cookies in production and Telegram requires HTTPS for webhooks

## 1b. A note on serverless (Vercel, Netlify, Cloudflare Workers)

**Do not deploy this to Vercel or any other serverless platform without porting the database first.**

The app stores everything — accounts, links, balances, the ledger — in a local SQLite file. Serverless functions have no persistent disk: the file lands in ephemeral `/tmp`, is not shared between concurrent instances, and is wiped on every cold start. It would not fail loudly. It would silently lose publisher balances.

Three other things break there too:

- Every database call in the app is **synchronous**; every serverless database driver is async.
- The background jobs (earnings release, promotion sweep, fraud rescoring) are `setInterval` on a long-lived process, which does not exist.
- Telegram pairing codes and delivery handles live in in-process `Map`s, so a second instance does not have them and file delivery breaks.

If you specifically need Vercel, the work is: port the data layer to Postgres or Turso, convert ~390 call sites to async, move those Maps into tables, and replace the jobs with Vercel Cron. That is a real project, not a config change.

Everything below assumes a **long-running container with a persistent volume**, which is what this app was built for.

## 1c. Deploying to Railway

Fastest path, and the one this repo is configured for. `railway.json` and the `Dockerfile` are already in place.

1. Push the repo to GitHub.
2. At [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**. Railway reads `railway.json` and builds the Dockerfile.
3. **Add a volume** — this is the step that matters. Service → **Variables/Settings** → **Volumes** → New Volume, mount path `/app/data`. Without it your database is deleted on every single deploy.
4. Set the three required secrets under **Variables**:

   ```bash
   # run locally, paste the output
   for k in SESSION_SECRET TOKEN_SECRET HASH_SALT; do
     echo "$k=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
   done
   ```

   Also set `TRUST_PROXY=1`. `BASE_URL` is optional — the app reads Railway's `RAILWAY_PUBLIC_DOMAIN` automatically.
5. Service → **Settings → Networking → Generate Domain**, or attach your own.

**Never raise the replica count above 1.** SQLite tolerates exactly one writer; two instances against one volume will corrupt it. `railway.json` pins `numReplicas: 1` — leave it.

## 1d. Deploying to Render

`render.yaml` is a complete blueprint. Import the repo at [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints).

It provisions the service, mounts a 1 GB disk at `/app/data`, generates the three secrets, and pins `numInstances: 1`. You fill in the `sync: false` values (support email, Telegram, AdSense) from the dashboard.

**Render's free tier has no persistent disk** — the filesystem resets on every deploy. For this app that means losing every account and balance, so use the Starter plan or higher.

## 1e. Deploying to a VPS with Docker

`docker-compose.yml` is set up for this. Put Caddy or nginx in front for TLS (section 4).

```bash
cat > .env <<'EOF'
BASE_URL=https://yourdomain.com
SESSION_SECRET=...
TOKEN_SECRET=...
HASH_SALT=...
EOF

docker compose up -d
docker compose logs -f
```

The named volume `linkvault-data` holds the database. Back it up (section 10).

## 1f. What the container does

Verified behaviour, not aspiration:

| | |
|---|---|
| Base image | `node:24-alpine` — Node 24 is **required**, `node:sqlite` is only unflagged from 23.4 |
| User | non-root (`node`, uid 1000) |
| Init | `tini` as PID 1, so SIGTERM reaches the app; it drains in ~1s |
| Healthcheck | `GET /healthz` every 30s |
| Data | `/app/data` — **must** be a mounted volume |
| Misconfiguration | exits **1** if any of the three secrets is missing, so a bad deploy fails visibly |
| Image size | ~256 MB |

## 2. Install

```bash
git clone <your-repo> /srv/linkvault
cd /srv/linkvault
npm ci --omit=dev
cp .env.example .env
```

## 3. Generate secrets

Production **refuses to boot** without all three:

```bash
for k in SESSION_SECRET TOKEN_SECRET HASH_SALT; do
  echo "$k=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
done >> .env
```

Rotation semantics, worth knowing before you ever rotate one:

| Secret | Rotating it |
|---|---|
| `SESSION_SECRET` | Signs everyone out. Harmless. |
| `TOKEN_SECRET` | Invalidates every in-flight unlock token. Visitors mid-flow must restart. |
| `HASH_SALT` | **Effectively permanent.** All historical IP and fingerprint hashes stop matching, so unique-visitor and repeat-click detection lose their history. |

Then set at minimum:

```env
NODE_ENV=production
BASE_URL=https://yourdomain.com
TRUST_PROXY=1
```

`TRUST_PROXY=1` matters more than it looks: without it every visitor appears to come from your proxy's IP, which collapses unique-visitor detection and makes the IP-burst signal fire on everyone.

## 4. Reverse proxy

### Caddy (simplest — TLS is automatic)

```caddy
yourdomain.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}
```

## 5. Put Cloudflare in front

Optional for the app, **not optional for your rate card**.

There is no bundled GeoIP database. Country is read from an edge header, and Cloudflare's free tier sets `CF-IPCountry` on every request. Without it every visit records as `XX` and prices at the wildcard rate — which means a US visitor and a low-tier visitor earn identically, and your rate card does nothing.

In the Cloudflare dashboard: proxy the record (orange cloud), SSL mode **Full (strict)**, and leave the default `CF-Connecting-IP` header on.

The app already reads `cf-ipcountry`, `x-vercel-ip-country`, `cloudfront-viewer-country`, `x-appengine-country` and `x-country-code`, so Vercel, CloudFront, Fastly and App Engine work without changes.

## 6. Run as a service (bare-metal alternative)

Skip this if you deployed with Docker in 1c–1e; it covers running the app directly on a VM without a container.

`/etc/systemd/system/linkvault.service`:

```ini
[Unit]
Description=LinkVault
After=network.target

[Service]
Type=simple
User=linkvault
WorkingDirectory=/srv/linkvault
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/linkvault/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin linkvault
sudo chown -R linkvault:linkvault /srv/linkvault
sudo systemctl enable --now linkvault
sudo journalctl -u linkvault -f
```

Note `ReadWritePaths`: with `ProtectSystem=strict` the app can only write to `data/`, which is all it needs.

## 7. First-run checklist

1. Sign in as `admin@linkvault.local` / `ChangeMe123`.
2. **Change that password immediately** (Dashboard → Settings).
3. Admin → Content → Policy pages: read all six, replace every `[bracketed placeholder]`, and have them reviewed for your jurisdiction.
4. Admin → Revenue: replace every rate-card row. The seeded values are conservative placeholders, not a forecast.
5. Admin → Revenue: set your publisher and referral share.
6. Admin → System: confirm skip mode is `none` unless you have a reason to change it (see the AdSense note below).
7. Admin → Content: publish real articles. Keep publishing.
8. Admin → Ad inventory: add your units once approved. Set a video id on `gw_video` if you want to feature a YouTube video in the flow.
9. Admin → Promotions: set your package prices if you plan to sell placements to creators.

## 8. Telegram bot

1. `@BotFather` → `/newbot` → copy the token.
2. Create a private channel, add the bot as an admin, note the chat id.
3. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_STORAGE_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`.
4. Restart, then Admin → System → **Register webhook**.

Telegram will only call a public HTTPS URL with a valid certificate. Self-signed will not work.

## 9. AdSense

Apply **after** the site has real content on it — a domain that is only a redirect gateway is rejected as "low value content", and reapplying without changing that does not help.

Before applying:

- Ten to twenty genuine articles, published over time
- All six policy pages completed and linked in the footer
- A working contact route
- Interstitial steps carrying real editorial content, not filler

Once approved:

```env
ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX
ADSENSE_ENABLED=true
```

Restart, then add each unit's `data-ad-slot` id at Admin → Ad inventory. `/ads.txt` is generated automatically from your publisher id.

### The one setting that can get you banned

The shipped flow is `SKIP_MODE=none`: the timer runs, then the Continue button at the bottom of the page unlocks by itself. No ad interaction is required or rewarded, which is the shape that survives review.

`SKIP_MODE=ad_click` changes that — it rewards a visitor for interacting with an ad. That is an **incentivised click**, which the AdSense program policies prohibit, and the outcome is account termination rather than a warning. Leave it alone unless you are running a network whose terms explicitly permit incentivised interaction.

`SKIP_MODE=engagement` sits in between: it allows an early skip once the visitor has engaged with your *content*. Still safe, but it shortens the flow, so it earns less per visit.

## 9b. Advertiser platform

Creators can buy placements two ways, and both land in Admin → Promotions.

**Self-serve** — account holders create and fund campaigns at `/dashboard/ads` or through `/api/v1/ads`.
**Form submission** — anyone can submit at `/promote` without an account.

### Setting it up

1. Admin → Promotions → edit the packages JSON to set your prices, terms and placements.
2. `/promote` is already linked from the nav and footer.
3. Decide how you take payment. **This panel is not a payment processor** — it records transactions. Use PayPal, a Stripe invoice, bank transfer, whatever you already run.

### Day-to-day

**Self-serve advertisers** hold prepaid credit. When their payment clears, go to Admin → Users → the account → **Ad credit**, add the amount and put the payment reference in the note. Their campaigns then fund themselves.

**Form submissions** have no account, so approve, invoice by email, and use **Mark paid** once settled.

Either way: review each campaign, then set it **active**. Rejecting a funded self-serve campaign refunds the advertiser's credit automatically.

### What to check before approving

The queue exists because you are lending your domain's reputation to someone else's link. Look at the destination, not just the card:

- Does the landing page match the headline?
- Is it in a category your ad partners allow? Adult, gambling and pharma will cost you your AdSense account, not just this placement.
- Is it a redirect chain, or the actual destination?
- Would you be comfortable with a reader clicking it?

Rejections are free for the advertiser, so there is no reason to be lenient.

### Do not weaken the disclosure

Every promoted card carries a "Promoted" label and `rel="sponsored nofollow"`. Both are enforced in `src/lib/promos.js` rather than in templates, precisely so they cannot be dropped by accident.

Selling do-follow links, or styling paid placements to look like editorial, risks your search standing and your ad account together. If an advertiser asks for either, the answer is no.

## 10. Backups

The database is one file, and it is everything — accounts, links, balances, the ledger.

```bash
#!/bin/bash
# /usr/local/bin/linkvault-backup
set -euo pipefail
DEST=/var/backups/linkvault
mkdir -p "$DEST"
# .backup is safe on a live WAL database; plain cp is not.
sqlite3 /srv/linkvault/data/linkvault.db ".backup '$DEST/linkvault-$(date +%F-%H%M).db'"
find "$DEST" -name 'linkvault-*.db' -mtime +30 -delete
```

```cron
0 */6 * * * /usr/local/bin/linkvault-backup
```

Do not `cp` a live WAL database — you can capture a torn state. Use `.backup`, or stop the service first.

**On Railway/Render/Docker**, run the same command inside the container and copy the file out:

```bash
# Docker / VPS
docker compose exec linkvault node -e "
  const {db} = require('/app/src/db');
  db.exec(\"VACUUM INTO '/app/data/backup.db'\");
" && docker compose cp linkvault:/app/data/backup.db ./linkvault-$(date +%F).db

# Railway
railway run node -e "const {db}=require('./src/db'); db.exec(\"VACUUM INTO '/app/data/backup.db'\")"
```

`VACUUM INTO` is the safe way to snapshot a live WAL database from inside the app's own process. Render also takes automatic disk snapshots on paid plans, but keep your own copies too — a snapshot you have never restored is not a backup.

Test a restore before you need one.

## 11. Maintenance

Background jobs run in-process and need no cron: earnings release every 15 min, session/token sweep hourly, publisher fraud rescoring every 30 min.

Manual, from Admin → System:

- **Prune old traffic & compact** — drops raw `visits`, `visit_steps` and `impressions` older than 180 days, then `VACUUM`. Rolled-up `daily_stats`, the `ledger` and `payouts` are never touched, so historical reporting and every balance survive.

## 12. Scaling

SQLite in WAL mode comfortably handles a single busy node. When you outgrow it, the order of operations is:

1. **Vertical first.** More CPU and faster disk goes a long way; the workload is small writes and indexed reads.
2. **Front it with a CDN.** `public/` is fully static and the gateway pages are small.
3. **Then reconsider storage.** The write path — visits, steps, ledger — is the bottleneck, not reads. `src/db/index.js` is a thin wrapper (`get`/`all`/`run`/`scalar`/`tx`), so porting to Postgres means rewriting that file and the `ON CONFLICT` clauses, not the application.

**Never run more than one instance against the SQLite file.** Not two replicas, not a network filesystem, not "just briefly during a deploy". SQLite allows exactly one writer, and two processes on one volume will corrupt the database that holds every balance you owe. `railway.json` and `render.yaml` both pin the instance count to 1 — leave them.

If you genuinely outgrow a single node, that is the point to port to Postgres, and the same port unlocks serverless hosting (section 1b).

## 13. Health

`GET /healthz` returns uptime, version and whether AdSense is live. Point your uptime monitor at it.

Because it returns 200 whenever the process is up, also alert on: log volume dropping to zero, `pending_payouts` growing unattended, and a sudden jump in fraud events.

## Troubleshooting

**Boots in dev, exits immediately in production**
Missing one of the three secrets. The reason is on stderr.

**Every visit shows country `XX`**
No edge header. See step 5.

**All traffic scores as invalid**
`TRUST_PROXY` is not set, so every visitor looks like one IP and the burst signals fire. Check that a visit's `fraud_reasons` contains `IP_BURST_MIN` to confirm.

**Telegram webhook will not register**
`BASE_URL` must be public HTTPS with a valid certificate. Check `journalctl` for Telegram's exact rejection.

**Ads show a placeholder box**
Expected until `ADSENSE_ENABLED=true` and `ADSENSE_CLIENT` are both set. The placeholder is deliberate — it holds the same space the real unit will, so the layout does not shift on approval.

**A publisher says their earnings are too low**
Compare their realised eCPM to the rate card on their dashboard, then walk the funnel: raw clicks → valid visits → completions. The gap is almost always at one stage, and usually traces to one traffic source.
