'use strict';

/**
 * Monetization campaign resolver.
 *
 * A campaign is an ordered list of steps. Nothing about "three pages" is
 * hard-coded — a campaign can be 1 step or 6, and `targeting.step_override`
 * can shorten or lengthen the flow per country or per device at request time.
 *
 * Step shape:
 * {
 *   key:      'discover',
 *   kind:     'article' | 'video' | 'offer' | 'quiz' | 'verify',
 *   title:    'Heading shown above the content',
 *   subtitle: 'One-line supporting copy',
 *   wait:     12,                 // seconds; falls back to campaign.wait_seconds
 *   slots:    ['gw_top','gw_mid'],// ad slot keys rendered on this step
 *   body:     'markdown content', // real editorial content (AdSense needs this)
 *   cta:      'Continue',
 *   require:  'scroll'|'click'|'none'  // the engagement gate for the skip button
 * }
 */

const { q, settings } = require('../db');
const config = require('../config');
const { parseJson, now } = require('./util');

const DEFAULT_STEPS = [
  {
    key: 'step-1',
    kind: 'article',
    title: 'Preparing your link',
    subtitle: 'The timer at the top is counting down. Read on while you wait — the Continue button at the bottom unlocks by itself.',
    wait: 15,
    slots: ['gw_top', 'gw_native_1'],
    require: 'none',
    cta: 'Continue to step 2',
    body: `### Why there is a short wait

You clicked a link that someone shared. Before it opens, this page runs a **15-second timer**. That is the whole ask — you don't have to click an advertisement, answer anything, or sign up.

The wait does two useful things:

- It gives our anti-fraud engine time to confirm you are a real visitor rather than a script. That is what keeps the payout honest for the person who shared the link with you.
- It funds the hosting, bandwidth and moderation behind the file or page you are about to reach.

### What happens next

There are three short steps. Each one has a timer at the top and a **Continue** button at the bottom. When the timer finishes, the button turns on and you press it. That is the entire flow.

> **We will never ask you to click an ad.** Ads on this page are ordinary display advertising. Clicking one is entirely optional and has no effect on your timer, your progress, or your link.

### Is my link safe?

Every destination on this platform is checked against a blocklist, and any link that receives a valid copyright or abuse report is disabled. If something looks wrong when you arrive, use the report form in our footer and we will look at it.`,
  },
  {
    key: 'step-2',
    kind: 'article',
    title: 'Step two of three',
    subtitle: 'Another short timer. New content and new ads have loaded — scroll down when the countdown finishes.',
    wait: 15,
    slots: ['gw_video', 'gw_mid', 'gw_native_2'],
    require: 'none',
    cta: 'Continue to step 3',
    body: `### How the delivery actually works

When you finish the last step, this platform issues a **signed completion token**. It is worth understanding what that is, because it is not a download link.

The token is a short, cryptographically signed string that says *"this specific visit completed the flow"*. It expires within minutes and can only be redeemed a couple of times. It carries no file path, and it is useless to anyone you send it to after it expires.

### Why files are not on a public URL

Files published here live in a **private Telegram vault**, not on a public bucket or an open directory. There is no address to guess and no folder to walk. When you redeem your token, a bot verifies the signature, checks the token has not been replayed, confirms the visit is still valid, and only then sends you the file.

That is why a shared "unlock" URL stops working for someone else — it was bound to your visit, and it has already expired.

### Skipping ahead does not work

The countdown is enforced on the server, not in your browser. Editing the page, disabling JavaScript, or calling the next URL directly returns a *"too early"* response until the real timer has actually elapsed. This is not there to annoy you — it is there because without it, automated traffic would drain the advertising revenue that pays the person whose link you followed.`,
  },
  {
    key: 'step-3',
    kind: 'verify',
    title: 'Last step — then your link',
    subtitle: 'One final short timer. When it finishes, scroll down and press Get my link.',
    wait: 10,
    slots: ['gw_bottom', 'gw_native_1'],
    require: 'none',
    cta: 'Get my link',
    body: `### Final checks

We are confirming a handful of signals about this session: request timing, whether the page behaved like a real browser, and whether the traffic pattern looks like a person rather than a script.

If any of that looks automated, **you still get your link**. The visit simply is not paid out to the publisher. That distinction is deliberate and worth stating plainly:

> Visitors are never blocked to protect revenue. Only revenue is withheld, to protect advertisers.

You will never be stuck behind a captcha, an app install, or a survey on this platform.

### After you press the button

The next page has your link on it, along with a short summary of what you are about to open. If the publisher attached a file, you will be handed off to our media bot to collect it.

### Want your own blog or video shown here?

We sell a small number of clearly-labelled promoted placements on these pages to bloggers and YouTube creators. If that is you, the **Promote** link in our footer has the details.`,
  },
];

function ensureDefault() {
  let row = q.get('SELECT * FROM campaigns WHERE owner_id IS NULL ORDER BY priority DESC, id ASC LIMIT 1');
  if (!row) {
    const res = q.run(
      `INSERT INTO campaigns (name, owner_id, steps, wait_seconds, skip_mode, targeting, priority, status, created_at)
       VALUES (?, NULL, ?, ?, ?, '{}', 100, 'active', ?)`,
      'Default 3-step flow (timer + Continue)',
      JSON.stringify(DEFAULT_STEPS),
      config.monetization.waitSeconds,
      config.monetization.skipMode,
      now(),
    );
    row = q.get('SELECT * FROM campaigns WHERE id = ?', Number(res.lastInsertRowid));
  }
  return row;
}

/**
 * Pick the campaign for a link, honouring link override -> publisher campaign ->
 * platform default, then apply country/device targeting to the step list.
 *
 * @returns {{campaign:object, steps:Array, waitSeconds:number, skipMode:string}}
 */
function resolve(link, ctx = {}) {
  let campaign = null;

  if (link.campaign_id) {
    campaign = q.get("SELECT * FROM campaigns WHERE id = ? AND status = 'active'", link.campaign_id);
  }
  if (!campaign) {
    const candidates = q.all(
      `SELECT * FROM campaigns
       WHERE status = 'active' AND (owner_id = ? OR owner_id IS NULL)
       ORDER BY (owner_id IS NOT NULL) DESC, priority DESC, id ASC`,
      link.user_id,
    );
    campaign = candidates.find((c) => matchesTargeting(c, ctx)) || candidates[0] || ensureDefault();
  }

  const targeting = parseJson(campaign.targeting, {}) || {};
  let steps = parseJson(campaign.steps, null);
  if (!Array.isArray(steps) || !steps.length) steps = DEFAULT_STEPS;

  // Per-country / per-device step count override, e.g. { "step_override": { "US": 2, "mobile": 2 } }
  const override = targeting.step_override || {};
  const wanted = Number(
    override[String(ctx.country || '').toUpperCase()] ?? override[String(ctx.device || '')] ?? steps.length,
  );
  if (Number.isFinite(wanted) && wanted > 0 && wanted < steps.length) {
    // Keep the first n-1 steps plus the final verify step so the flow still ends properly.
    steps = wanted === 1 ? [steps[steps.length - 1]] : [...steps.slice(0, wanted - 1), steps[steps.length - 1]];
  }

  const globalSkip = settings.get('skip_mode', null);
  return {
    campaign,
    steps,
    waitSeconds: campaign.wait_seconds || config.monetization.waitSeconds,
    skipMode: globalSkip || campaign.skip_mode || config.monetization.skipMode,
  };
}

function matchesTargeting(campaign, ctx) {
  const t = parseJson(campaign.targeting, {}) || {};
  if (Array.isArray(t.countries) && t.countries.length) {
    if (!t.countries.map((c) => String(c).toUpperCase()).includes(String(ctx.country || '').toUpperCase())) return false;
  }
  if (Array.isArray(t.devices) && t.devices.length) {
    if (!t.devices.includes(String(ctx.device || ''))) return false;
  }
  return true;
}

/** Normalise operator-supplied step JSON before it is saved. */
function sanitizeSteps(input) {
  const arr = Array.isArray(input) ? input : parseJson(input, null);
  if (!Array.isArray(arr) || !arr.length) throw new Error('Steps must be a non-empty JSON array.');
  if (arr.length > 8) throw new Error('A campaign can have at most 8 steps.');
  return arr.map((s, i) => ({
    key: String(s.key || `step_${i + 1}`).slice(0, 40),
    kind: ['article', 'video', 'offer', 'quiz', 'verify'].includes(s.kind) ? s.kind : 'article',
    title: String(s.title || `Step ${i + 1}`).slice(0, 160),
    subtitle: String(s.subtitle || '').slice(0, 240),
    wait: Math.max(0, Math.min(120, Number(s.wait) || 0)),
    slots: Array.isArray(s.slots) ? s.slots.slice(0, 6).map((x) => String(x).slice(0, 40)) : [],
    require: ['scroll', 'click', 'none'].includes(s.require) ? s.require : 'scroll',
    cta: String(s.cta || 'Continue').slice(0, 60),
    body: String(s.body || '').slice(0, 20000),
  }));
}

module.exports = { DEFAULT_STEPS, ensureDefault, resolve, sanitizeSteps, matchesTargeting };
