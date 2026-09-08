# LinkVault

A short-link **platform** — publisher dashboard, configurable monetization flow, anti-fraud engine, revenue ledger, admin panel, developer API, and Telegram-backed file delivery.

Not a redirector with ads bolted on. The difference is the six engines below, each independently configurable from the admin panel.

```
  visitor clicks  yourdomain.com/s/X8K29D
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  STEP 1     ⏱ timer at the top of the page  │
  │             article content + ads            │
  │             [ Continue ]  ← at the bottom,   │
  │                             unlocks by itself│
  └─────────────────────────────────────────────┘
        ▼   (new content, ads reload)
  ┌─────────────────────────────────────────────┐
  │  STEP 2     ⏱ timer  →  [ Continue ]        │
  └─────────────────────────────────────────────┘
        ▼   (new content, ads reload)
  ┌─────────────────────────────────────────────┐
  │  STEP 3     ⏱ timer  →  [ Get my link ]     │
  └─────────────────────────────────────────────┘
        ▼
  signed completion token  (HMAC-SHA256, expiring)
        ▼
  link page  →  destination URL, or the Telegram media bot for a file
```

**The visitor is never asked to click an ad.** The timer runs on its own, the
Continue button at the bottom of the page turns on by itself when it finishes,
and ads are ordinary display units that have no effect on progress.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>.

Two accounts are seeded in development:

| | Email | Password |
|---|---|---|
| Admin | `admin@linkvault.local` | `ChangeMe123` |
| Publisher | `demo@linkvault.local` | `Demo12345` |

**Change the admin password immediately.** The seed prints a warning about this.

## Requirements

- **Node.js 24** (the Docker image pins it). The database is Node's built-in `node:sqlite`, which is only unflagged from 23.4 — on Node 22 it needs `--experimental-sqlite`. No native module to compile, nothing to install for storage.
- Three runtime dependencies: `express`, `ejs`, `cookie-parser`. No build step, no bundler, no CDN.

## What is in the box

### 1. Publisher dashboard
Create links, attach vault files, per-link analytics, country/device/browser/OS/referrer breakdowns, live visit feed, earnings ledger, withdrawals, referral programme, custom monetization flows, **ad campaigns with their own analytics**, API keys, session management.

### 2. Link engine
`/s/CODE` with custom aliases, expiry dates, click limits, pause/resume, and per-link flow overrides.

### 3. Monetization engine
A campaign is an **ordered list of steps**, stored as JSON. Nothing about "three pages" is hard-coded — run one step or eight, and override the step count per country or per device at request time:

```json
{ "step_override": { "US": 2, "mobile": 2 } }
```

Each step carries its own wait time, ad slots, and markdown content.

**The countdown is enforced server-side** against `visit_steps.entered_at`. The client timer is presentation only; editing it in devtools, disabling JavaScript, or calling the next URL directly returns `425 Too Early` until the real timer has actually elapsed.

The shipped flow is deliberately plain:

| | |
|---|---|
| Timer position | Sticky bar at the top, with a reading-progress line, a step tracker and a countdown ring |
| During the wait | Nothing is required. The visitor reads, scrolls, or waits |
| Continue button | At the **bottom** of the content, disabled until the timer finishes, then it unlocks with a glow |
| If they haven't scrolled | A floating "Continue ↓" pill appears and scrolls them to the button |
| Last step | The button reads **Get my link** |

### 4. Revenue engine
Rate cards by country and device (most specific match wins), fill-rate modelling, an immutable ledger, a configurable hold window before earnings become withdrawable, referral share taken from the platform cut, and one-click reversal on a fraud finding.

Money is stored in **micros** (1 USD = 1,000,000). No floats anywhere in the money path.

### 5. Anti-fraud engine
Twenty-five named signals across two scoring passes — entry and completion. Every signal is stored on the visit, so an admin can explain any decision rather than pointing at a number. See `src/lib/fraud.js` for the full catalogue, or Admin → Anti-fraud for it rendered with weights.

Two principles are baked in:

- **A visitor is never blocked to protect revenue.** Traffic that fails scoring still reaches its destination; it simply is not paid for.
- **Suspicious traffic is discounted, not dropped.** A middle band pays at a reduced rate, mirroring how ad networks actually reprice low-quality inventory.

### 6. Telegram file vault
Files live in Telegram storage, addressed by a `file_id` that is meaningless without the bot token. No public URL, no bucket to enumerate. The bot re-verifies the signed completion token — and the underlying visit's state — before it releases a single byte.

Everything degrades gracefully when the bot is not configured: plain destination links work regardless.

### 7. Admin panel
Users (including ad-credit top-ups), links, file moderation, traffic, anti-fraud with blocklists and reversals, rate cards, revenue split, payouts, monetization flows, ad inventory, advertiser campaign review, blog/product/policy content, contact inbox, system health, audit log, and database maintenance.

### 8. Public content site
Home, blog with tags, product catalogue, payouts page, a **Promote with us** page for advertisers, contact form, and six policy pages (Privacy, Terms, Cookies, DMCA, Disclaimer, About) — plus `robots.txt`, `sitemap.xml` and `ads.txt`.

This exists because **an ad network reviews the site, not the redirect**. See [AdSense readiness](#adsense-readiness).

## AdSense readiness

The default flow asks nothing of the visitor beyond waiting, which is the shape that survives an AdSense review. Ads sit alongside content; they are never a gate.

It is worth being explicit about the thing this deliberately does **not** do. A very common shortener pattern is *"wait 15 seconds, or click the ad below to skip"*. That is an **incentivised click**, which the Google AdSense program policies prohibit — the outcome is account termination, not a warning. This build does not ship that behaviour.

`SKIP_MODE` (settable in `.env`, at Admin → System, or per-campaign):

| Mode | Behaviour | AdSense |
|---|---|---|
| `none` **(default, and what the seeded flow uses)** | Timer only. Continue unlocks when the countdown ends. | ✅ Safe |
| `engagement` | Additionally allows an early skip once the visitor has engaged with the **page content**. | ✅ Safe |
| `ad_click` | Allows an early skip on an **ad interaction**. | ❌ Prohibited — only for a network whose terms permit it |

The admin UI and the campaign editor both carry that warning inline, so nobody flips it by accident.

Everything else needed for a review is already wired:

- **Real editorial content on every interstitial step**, rendered from markdown — not filler around a countdown.
- **Four seeded long-form blog articles** plus a full editor. Keep publishing; four articles is a starting point, not a content strategy.
- **Every ad unit is labelled** "Advertisement" and separated from the controls a visitor needs to press.
- **All six policy pages**, written to describe what this software actually does — including that it serves third-party advertising and what that means for visitor data.
- **`/ads.txt`** generated from your publisher ID, or overridden wholesale via `ADS_TXT`.
- **The gateway is `noindex`** and excluded in `robots.txt`; only real content is indexable.
- **Ad slots render sized placeholders until approval**, so your layout is identical before and after — no "site looks broken while under review".

Turning ads on:

```env
ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX
ADSENSE_ENABLED=true
```

Then put each unit's `data-ad-slot` id in the slot's HTML field at Admin → Ad inventory.

**Read the policy pages before you go live.** They are a starting template with bracketed placeholders, not legal advice.

## Advertiser platform

Beyond network ads, creators can buy your **own** inventory — a flat-fee placement for a YouTube video, blog post or product, shown inside the link flow and on article pages.

There are two ways in, and both land in the same moderation queue:

**Self-serve** (account holders) — a campaign dashboard at `/dashboard/ads` and a full REST API. Create a campaign, fund it from prepaid credit, and read live analytics.

**Form submission** (no account) — `/promote` shows packages and takes a submission. Free to submit; you invoice manually.

### Lifecycle

```
draft ──fund──> pending ──you approve──> active ──term ends──> expired
                   └──── you reject ───> rejected  (credit refunded automatically)
                                  active <── pause / resume ──> paused
```

Only **active + paid** campaigns render. A background job sweeps every 15 minutes to activate funded campaigns and retire expired ones.

The advertiser controls funding, pausing and cancellation. **Approval is yours alone** — the API returns `403 status_not_allowed` if a creator tries to set it. Editing the creative on a live campaign automatically sends it back for re-review, so a vetted card cannot be swapped for something else after approval.

### Credit and refunds

Advertisers hold a prepaid **ad credit** balance, topped up by an admin at Admin → Users → *Ad credit* once payment clears. This panel records the transaction; it does not process payments — wire up whatever you already use.

Refunds are automatic and consistent:

| Situation | Outcome |
|---|---|
| Rejected in review | Full refund to ad credit |
| Cancelled before going live | Full refund |
| Cancelled after going live | No refund — the impressions were delivered |

Every movement is written to the same immutable ledger as publisher earnings, as `ad_credit`, `ad_spend` and `ad_refund`.

### Analytics

Delivery is rolled up daily per campaign by **surface, country and device**, so an advertiser gets:

- Impressions, clicks, CTR, cost-per-click and effective CPM
- A day-by-day delivery chart
- Breakdowns by country, device, and which surface delivered it (link flow / blog / site)

Viewability is measured with an IntersectionObserver at 50% visibility, not on render — an impression means the card was actually on screen.

### Advertiser API

```bash
# promote a video
curl -X POST "https://yourdomain.com/api/v1/ads/campaigns" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"kind":"youtube","package":"spotlight",
       "title":"My new video","youtube_id":"https://youtu.be/VIDEO_ID"}'

# read delivery
curl -H "Authorization: Bearer $KEY" \
  "https://yourdomain.com/api/v1/ads/campaigns/12/stats?days=30"
```

`GET /packages` · `GET /account` · `GET /stats` · `GET|POST /campaigns` · `GET|PATCH|DELETE /campaigns/:id` · `POST /campaigns/:id/fund` · `GET /campaigns/:id/stats`

Same API key as the publisher API — one integration covers publishing links and buying placements. Full reference at Dashboard → API.

### Packages

Editable as JSON at Admin → Promotions:

| Package | Price | Term | Placement |
|---|---|---|---|
| Starter | $5 | 7 days | Blog + article pages |
| Spotlight | $15 | 14 days | Inside the link flow |
| Takeover | $35 | 30 days | Every surface, top rotation weight |

### Disclosure

**Enforced in code, not left to templates.** Every promoted item renders a visible "Promoted" label, and outbound links carry `rel="sponsored nofollow"` — what Google's paid-link guidelines and consumer-protection rules expect. Selling a do-follow link would put both your search standing and your ad account at risk, so the renderer does not offer the option.

Submissions are validated against the same SSRF guard as link destinations, run through a honeypot, and rate-limited. Campaigns are scoped to their owner: another account requesting one gets a `404`.

## Ad inventory

Six slot types across three placements. Slot keys the templates look for:

- **Gateway** — `gw_top`, `gw_mid`, `gw_bottom`, `gw_native_1`, `gw_native_2`, `gw_video`, `gw_unlock`
- **Site** — `site_mid`, `site_side`
- **Blog** — `blog_top`, `blog_bottom`, `blog_side`

Four providers: `adsense` (real ad units), `youtube` (privacy-enhanced `youtube-nocookie` embeds — `gw_video` is seeded for this and renders nothing until you set a video id), `house` (your own promos with click tracking via `/out/:slot`), and `custom` (paste a network tag — admin-only field, injected verbatim).

Popups are frequency-capped per session and configurable for delay and cap.

## Developer API

Bearer-token REST at `/api/v1`. 300 req/min.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://yourdomain.com/api/v1/shorten?url=https://example.com/file.zip"
```

**Publisher:** `GET /me` · `GET|POST /links` · `GET|PATCH|DELETE /links/:code` · `GET /stats` · `GET /files` · `GET /shorten`

**Advertiser:** `GET /ads/packages` · `GET /ads/account` · `GET /ads/stats` · `GET|POST /ads/campaigns` · `GET|PATCH|DELETE /ads/campaigns/:id` · `POST /ads/campaigns/:id/fund` · `GET /ads/campaigns/:id/stats`

One key covers both. Full reference at Dashboard → API.

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather); copy the token.
2. Create a private channel, add the bot as an admin, and note its chat id.
3. Fill in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_STORAGE_CHAT_ID`.
4. Restart, then Admin → System → **Register webhook**. Telegram needs a public HTTPS URL — on localhost, tunnel first (`cloudflared`, `ngrok`) and point `BASE_URL` at the tunnel.
5. Publishers pair from Dashboard → File vault, then send the bot any file.

## Country data

There is no bundled GeoIP database. Country comes from an edge header — Cloudflare (`CF-IPCountry`, free tier), Vercel, Fastly, CloudFront and App Engine all set one. Behind a bare origin the country is `XX` and the rate card falls back to its wildcard row.

**Put Cloudflare in front.** Country is what your rate card is priced on.

## Layout

```
server.js               app wiring, background jobs, boot
src/config.js           env loading, dev-secret cache
src/db/
  schema.sql            full schema, money in micros
  index.js              node:sqlite connection + query helpers
  seed.js               idempotent seed
  seed-pages.js         six policy page templates
  seed-posts.js         four seeded articles
src/lib/
  util.js               ids, money, dates, markdown, URL safety
  auth.js               scrypt passwords, sessions, API keys
  tokens.js             HMAC step + completion tokens
  geo.js                country / device / bot classification
  fraud.js              the 25-signal scoring engine
  revenue.js            rate cards, pricing, ledger, hold + release
  campaigns.js          step-flow resolution and targeting
  ads.js                slot rendering for all four providers
  promos.js             promotions: packages, rotation, disclosure, credit, analytics
  telegram.js           bot API, vault storage, delivery links
  stats.js              shared aggregation queries
src/middleware/         context, session, CSRF, rate limit, guards
src/routes/             gateway, auth, dashboard, admin, api, ads-api, public, webhooks
src/views/              EJS templates
public/css/app.css      the whole design system
public/js/              app, charts (hand-rolled SVG), gateway engine
```

## Security notes

- Passwords: scrypt, N=16384. IPs and fingerprints: HMAC-SHA256 with a secret salt — **raw IPs are never stored**.
- CSRF on every state-changing form. Exempt paths (`/api/v1`, `/webhooks`, `/gw`) each carry a stronger, unguessable credential of their own.
- Sessions are httpOnly + SameSite=Lax, `Secure` in production. Changing a password revokes every other session.
- Destination URLs are validated against loopback and RFC1918 ranges to block SSRF.
- Admin actions are written to an audit log.
- Custom ad HTML is injected verbatim and is admin-writable only. Do not paste a tag you have not read.

## Scripts

```bash
npm start        # run
npm run dev      # run with --watch
npm run seed     # re-run the idempotent seed
npm run reset    # wipe content/config tables and re-seed (users and money untouched)
```

## Deploying

The app is a **long-running Node process with a SQLite file on a persistent volume**. Pick a host that gives you both.

```bash
docker compose up -d          # local or VPS
```

| Host | Config in repo | Notes |
|---|---|---|
| **Railway** | `railway.json` + `Dockerfile` | Fastest. Add a volume at `/app/data` — this is the step people skip |
| **Render** | `render.yaml` blueprint | Declares the disk and generates secrets. Needs a paid plan; the free tier has no persistent disk |
| **VPS / Docker** | `docker-compose.yml` | Named volume `linkvault-data`, Caddy or nginx in front |
| **Fly.io** | `Dockerfile` | Attach a volume at `/app/data` |

Set `TRUST_PROXY=1` and the three secrets (`SESSION_SECRET`, `TOKEN_SECRET`, `HASH_SALT`) — production refuses to boot without them. `BASE_URL` is auto-detected on Railway, Render and Fly.

**One instance only.** SQLite allows exactly one writer; two replicas on one volume corrupt the database that holds every balance you owe. Both config files pin the replica count to 1.

If the data directory is not a mounted volume, the app prints a loud startup warning rather than quietly serving traffic it is about to lose.

### Not serverless

**Vercel, Netlify and Cloudflare Workers will not work without a port.** No persistent disk means the database lands in ephemeral `/tmp`, is not shared between instances, and is wiped on every cold start — silently. On top of that, all ~390 database calls are synchronous, the background jobs are `setInterval` on a long-lived process, and Telegram pairing state lives in in-process memory.

Making it serverless means porting the data layer to Postgres or Turso, converting those call sites to async, moving that state into tables, and replacing the jobs with platform cron. [DEPLOY.md §1b](DEPLOY.md) has the detail.

See [DEPLOY.md](DEPLOY.md) for the full walkthrough, backups and troubleshooting.

## A word on the numbers

The seeded rate cards are **conservative placeholders, not a forecast**. Short-link CPM varies enormously by country, device, traffic source, ad network and fill rate, and published third-party comparison tables disagree with each other and are frequently marketing material.

Measure your own funnel first, read your own network's reporting, and set the card from that. Set it low and raise it — cutting a rate publishers have already seen destroys trust permanently.

The dashboard shows each publisher their **realised eCPM** alongside the card, because that number cannot be wrong.

See [DEPLOY.md](DEPLOY.md) for production setup.
