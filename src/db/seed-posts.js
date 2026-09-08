'use strict';

/**
 * Seeded blog articles.
 *
 * These exist because an ad-network review looks for original, substantive
 * writing — a site that is nothing but a redirect gateway does not get approved.
 * They are real articles about the domain, not filler. Edit or replace them from
 * Admin → Content, and keep publishing: three articles is a starting point, not
 * a finished content strategy.
 */

const ALL = [
  {
    slug: 'why-link-shorteners-get-rejected-by-ad-networks',
    title: 'Why link shorteners get rejected by ad networks — and what to do instead',
    excerpt: 'Most monetized shorteners fail ad-network review for the same four reasons. All four are fixable, and none of them require abandoning the model.',
    tags: 'monetization, ad policy, compliance',
    body: `Almost every operator who builds a monetized short-link site eventually applies to a major ad network, and most of them get rejected. The rejection email is famously unhelpful — usually some variant of "your site does not comply with our policies" — so people guess, change something at random, and reapply until they give up.

The reasons are actually quite predictable. Here are the four that account for nearly all of it.

## 1. There is no content

This is the big one, and it is structural rather than cosmetic.

An ad network is buying inventory. Inventory means a page that a person has a reason to be on. A page whose entire purpose is to delay someone for fifteen seconds on the way to somewhere else is, from the network's point of view, not inventory — it is a tollbooth with a banner nailed to it.

Reviewers describe this as "low value content", "no original content", or "site under construction", and the fix is not to write three paragraphs of filler around the countdown. The fix is to have a site that would be worth visiting if the shortener did not exist:

- **Editorial content on the interstitial itself.** Not lorem ipsum, not a paragraph about how you should wait. Something a visitor could plausibly read and get value from.
- **A blog with real articles.** Ten to twenty pieces of genuine writing, published over time, on subjects your audience cares about.
- **Pages that describe your actual service** — how payouts work, what the rules are, who runs it.

The interstitial being monetized is not itself the problem. The problem is when the interstitial is the *only* thing on the domain.

## 2. Incentivised clicks

This one gets accounts banned rather than merely rejected, and it is worth being precise about.

A very common shortener pattern is: *"wait 15 seconds, or click the ad below to skip."*

Read that as an ad network would. You are offering a visitor something they want — their time back — in exchange for clicking an ad. That is the textbook definition of an incentivised click, and Google's AdSense program policies prohibit it explicitly. The clicks you generate this way are worthless to the advertiser, the network can detect the pattern statistically, and the outcome is an account termination rather than a warning.

The workable alternative is to gate the skip on **engagement with your content**, not with the ad:

- Reading to the bottom of the article unlocks the skip.
- Answering a question about the content unlocks the skip.
- Any genuine interaction with the *page* unlocks the skip.

The visitor still gets to skip. You still get an engaged pageview instead of an idle one. Nobody is being paid to click an ad. From a revenue perspective this is often *better*, because engaged sessions produce better viewability metrics, and viewability is what actually drives your effective CPM.

If you are running a network whose terms genuinely permit incentivised interaction, that is between you and that network — but do not run it on AdSense inventory and hope.

## 3. Ads placed to catch accidental clicks

Reviewers look for ad placement that appears designed to be misclicked:

- An ad directly under the "Continue" button
- Ads styled to look like site navigation or download buttons
- Ads inside the flow of a form
- Anything unlabelled

The rule of thumb is simple: **would a hurried visitor be able to tell, at a glance, what is an ad and what is your interface?** If not, move it. Label every unit. Put clear space between advertising and any control the visitor needs to press.

This costs you some accidental clicks. Accidental clicks were never worth anything anyway — they convert at zero, and the advertiser eventually notices.

## 4. No policy pages, or copy-pasted ones

Reviewers check for a privacy policy, terms, and a contact route. They check that the privacy policy actually describes what your site does — including that you serve third-party advertising and what that means for the visitor's data.

A generic template with another company's name still in it is worse than none. So is a privacy policy that says you collect nothing while your site sets five cookies.

Write the policy that matches your actual behaviour: what you collect, why, how long you keep it, who else receives it, and how someone exercises their rights.

## The uncomfortable summary

If your business model requires that the interstitial has no content, that visitors are paid to click ads, and that ad placement is deliberately confusing, then no amount of tuning gets you approved, and you should be looking at ad networks that serve this category explicitly rather than at the mainstream ones.

If you are willing to run the interstitial as a real page — actual content, honest ad labelling, a skip gated on reading rather than clicking — then the model works, and it survives review.

The second version also happens to make more money per thousand visits, because engaged inventory is worth more than idle inventory. That is not a coincidence.`,
  },

  {
    slug: 'anatomy-of-invalid-traffic',
    title: 'The anatomy of invalid traffic: 12 signals worth scoring',
    excerpt: 'Bot detection is not one check, it is a scorecard. Here is what actually goes on it, why each signal earns its weight, and where each one gives false positives.',
    tags: 'anti-fraud, traffic quality, engineering',
    body: `If you monetize traffic, some fraction of what you are counting is not a person. The question is not whether to filter it but how, and the answer is almost never a single check.

A single check is brittle in both directions. Block every visitor with an empty user-agent and you catch some bots and some people behind aggressive privacy tooling. Block nothing and your advertiser relationships do not survive contact with reality.

What works is a **scorecard**: many weak signals, each contributing weight, with thresholds that decide whether a visit is paid in full, paid at a discount, or paid nothing. Here is what belongs on it.

## Entry signals — cheap, evaluated before the flow starts

**1. Automation user-agent.** \`curl\`, \`python-requests\`, \`headless\`, \`puppeteer\`, and several hundred crawler strings. High weight, low false-positive rate. The only real cost is that some privacy tools spoof unusual agents.

**2. Link-preview crawlers.** WhatsApp, Telegram, Discord, Slack and Facebook all fetch a URL to build an unfurl card. These are not fraud — they are legitimate infrastructure. Treat them as a separate category: serve them a clean Open Graph card, count nothing, and never pay for them. Lumping them in with bots inflates your fraud numbers and teaches you nothing.

**3. Missing \`Accept-Language\`.** Real browsers send it. Scripts often do not. Low weight on its own — a meaningful contributor when combined.

**4. Not requesting HTML.** A client that asks for \`*/*\` and never for \`text/html\` is not rendering your page.

**5. IP burst.** More than N visits from one hashed IP in a minute, or M in an hour. Watch the thresholds: carrier-grade NAT means a whole mobile network can share an address, so set these generously or you will punish entire countries.

**6. Link spray.** One IP hitting many *different* links belonging to the same publisher in a short window. This is a much stronger signal than raw volume, because it is the shape of someone testing their own links rather than a shared connection.

**7. Repeat clicks.** The same IP on the same link inside the uniqueness window. Not necessarily fraud — people do reopen links — but it should not be paid twice.

**8. Self-traffic.** The visiting IP recently held an authenticated session for the publisher who owns the link. This catches the most common form of small-scale fraud, which is people clicking their own links.

## Completion signals — evaluated with evidence from the flow

**9. No JavaScript probe.** Your page runs a small script that posts back. If nothing arrives, either the client does not run JavaScript or it is not really rendering the page. Both mean the ad did not render either.

**10. Headless markers.** \`navigator.webdriver\`, a zero-length plugin array on a desktop UA, an empty \`navigator.languages\`, zero \`outerWidth\`. Individually weak and individually spoofable; in combination, informative.

**11. Impossible timing.** The visit completed faster than a human could plausibly read the page. This is the highest-signal check available and it is almost impossible to fake without actually waiting, which is the whole point.

**12. No interaction, no focus.** Zero pointer, keyboard, or scroll events across the entire flow, and a tab that never held focus. A person waiting fifteen seconds still moves their mouse, and their tab is usually in the foreground. A script does neither.

## Publisher-level anomalies

Individual visits are noisy; publishers are not. A publisher with two hundred visits a day and a **97% completion rate** is anomalous, because real traffic has real drop-off. Somewhere between 40% and 75% is normal depending on your flow length. Above 95% at volume means either the flow is being automated or the numbers are being manufactured.

Score this at the account level and let it feed into every visit that account generates.

## Thresholds, and the case for discounting

Rather than a binary valid/invalid, use two thresholds:

- **Review band** — suspicious but not conclusive. Pay at a reduced rate.
- **Reject band** — pay nothing.

The middle band matters more than it looks. Ad networks do not blacklist you for a bad impression; they quietly reprice your inventory. Mirroring that internally means your publishers experience the same economics you do, which is both more honest and more accurate than pretending every visit is either perfect or worthless.

## Two rules that matter more than the scorecard

**Never block a visitor to protect revenue.** If a visit scores badly, deliver the destination anyway and simply do not pay for it. A visitor who cannot get their file because your fraud engine had a bad day is a visitor your publisher loses, and they will not know why.

**Make every decision explainable.** Store the named signals that fired, not just a number. When a publisher asks why their traffic was rejected, "score 74" is useless. "IP_BURST_MIN, NO_JS, IMPOSSIBLE_SPEED, NO_INTERACTION" is a conversation, and often an actionable one — that publisher has one bad traffic source and can cut it.

An unexplainable fraud engine is indistinguishable, from the outside, from a platform that simply does not want to pay.`,
  },

  {
    slug: 'how-to-model-short-link-revenue-honestly',
    title: 'How to model short-link revenue without lying to yourself',
    excerpt: 'Published CPM tables for short-link platforms are marketing. Here is how to build a projection from numbers you can actually verify.',
    tags: 'monetization, revenue, guides',
    body: `Search for short-link CPM rates and you will find dozens of tables, all confident, all different, many differing by a factor of five for the same country. They cannot all be right. Most of them are marketing material, several are copied from each other, and almost none say what traffic they describe.

If you are deciding whether to build on this model, or telling publishers what they might earn, you need a projection built from things you can check.

## Start from the funnel, not the CPM

The headline mistake is multiplying clicks by a CPM. Clicks are not impressions, and impressions are not paid impressions. The real chain has leaks at every stage:

\`\`\`
raw clicks
  → minus bots and preview crawlers        (typically 10-35%)
  = valid visits
  → minus people who abandon the flow      (typically 15-50%)
  = completed visits
  → times ad fill rate                     (typically 75-95%)
  = paid impressions
  → times CPM / 1000
  = gross revenue
  → times your publisher share
  = what the publisher actually receives
\`\`\`

Each of those five ranges is wide, and they multiply. Take a hundred thousand raw clicks. Optimistic end of every range: about 76,000 paid impressions. Pessimistic end: about 25,000. That is a 3× spread before CPM enters the picture at all.

This is why two publishers with identical click counts report wildly different earnings and each assume the other is lying.

## Which numbers you can actually verify

**You can verify your own funnel immediately.** Bot rate, completion rate and abandonment are visible in your own data from day one. They do not depend on any ad network. Measure them before you model anything.

**You can verify fill rate within a week** of running live ads, from your network's reporting.

**CPM is the number you cannot verify in advance**, and it is the one every published table claims to know. It varies by country, device, ad format, viewability, seasonality, the specific network, and how that network has categorised your inventory. Q4 in a tier-1 market can be double Q1 for identical traffic.

## Build the model in the right order

1. **Measure your funnel with a placeholder rate.** Set every rate-card row to a single conservative number. Run real traffic. Learn your actual bot rate, completion rate and country mix. This costs you nothing and takes a week.

2. **Turn on ads and read your network's reporting.** Not your own estimate — theirs. That is your real CPM, for your real traffic, in your real geographic mix.

3. **Backfill the rate card from that reporting.** Now your numbers describe your site rather than someone's landing page.

4. **Re-check every quarter.** Rates move. A card set in November and never revisited will overstate February badly.

## Set the card low and raise it

If you run a platform paying publishers a share, there is an asymmetry worth understanding.

Set the card too high and you accrue a liability you cannot fund. Publishers watch a balance grow, request payouts, and you either pay out more than you earned or you cut the rate — and cutting a rate publishers have already seen destroys trust permanently. Every platform that has done this has a forum thread about it.

Set the card too low and publishers earn less than expected for a while, then you raise it. Raising rates is the easiest announcement in the business.

Start conservative. You can always be generous later.

## Report eCPM, not CPM

The single most useful number to show a publisher is their **realised eCPM**: what they actually earned, divided by their valid visits, times a thousand.

Unlike a rate card, it cannot be wrong. It already includes their bot rate, their completion rate, their country mix and current fill. If it is lower than they hoped, the funnel breakdown tells them exactly which stage is leaking.

A rate card is a projection. Realised eCPM is a fact. Publishers who are shown both, and shown how they relate, complain much less than publishers shown only an aspirational table.

## What to tell publishers

Say the true thing, which is more persuasive than the marketing version anyway:

> Your earnings depend on where your visitors are, what devices they use, where the traffic comes from, and whether it is real. We publish our rate card so you can see how we price traffic, and your dashboard shows what you are actually realising. If those two numbers diverge, the funnel breakdown will show you why.

That is a claim you can keep. "Earn up to $20 CPM" is not.`,
  },

  {
    slug: 'delivering-files-without-a-public-url',
    title: 'Delivering files without ever exposing a public URL',
    excerpt: 'Signed, expiring, single-use tokens and a bot that verifies them — how to gate a download so that sharing the unlock link does not share the file.',
    tags: 'engineering, security, file delivery',
    body: `The oldest problem in file publishing: you want a visitor to complete something before they get the file, but the moment you hand them a URL, that URL works for everyone.

Somebody posts it in a forum. Somebody scrapes your pattern and enumerates it. Your bandwidth bill is now funding people who never saw the page you built.

The fix is to stop treating the file as something that has a URL at all.

## Capability tokens, not file paths

Instead of "here is where the file is", issue **"here is proof that you earned the file"** — a credential the delivery layer verifies before it resolves anything.

A compact token looks like this:

\`\`\`
base64url(payload) . base64url(HMAC-SHA256(payload, secret))
\`\`\`

with a payload carrying the visit id, the link id, a unique token id, an issued-at and an expiry. Concretely:

\`\`\`json
{ "t": "done", "j": "kR9x...", "v": 84213, "l": 77, "iat": 1735689600, "exp": 1735690500 }
\`\`\`

The properties that matter:

- **Unforgeable.** Without the secret you cannot produce a valid MAC. Verify with a constant-time comparison so you do not leak information through timing.
- **Self-describing.** The receiver reads the expiry and the subject from the token without a database round trip.
- **Short-lived.** Fifteen minutes is plenty. Posting it publicly gives strangers fifteen minutes, not forever.
- **Bound to a visit.** It refers to a specific visit that specific server marked complete.

## Persist the token id anyway

A signature alone cannot be revoked, and revocation is exactly what you need when a fraud sweep later determines a visit was fake. So store a row keyed by the token id with its expiry and a use counter.

Two things become possible:

**Use limits.** Allow two or three redemptions, not one. Strict single-use looks rigorous and generates support tickets — a flaky mobile connection, a retried tap, a browser prefetch, and a legitimate visitor is locked out of something they earned. A small allowance absorbs reality without meaningfully helping an abuser, whose problem is the fifteen-minute window rather than the count.

**Revocation.** Delete the row and every copy of that token stops working immediately, regardless of signature validity.

## Verify at the point of delivery

The important architectural move is *where* verification happens.

If your web server verifies the token and then streams the file, your web server still has to be able to reach the file, and any bug in that path leaks it. Better to move delivery into a separate component that verifies independently:

\`\`\`
visitor completes flow
  → platform issues signed token
  → visitor opens the delivery bot with that token
  → bot verifies signature, expiry, use count, visit state
  → bot resolves the storage handle and sends the file
\`\`\`

Using Telegram as the storage layer, the file is addressed by a \`file_id\` that is meaningless without the bot token. There is no URL to leak, no bucket to enumerate, no directory to walk. Telegram serves the bytes, so your origin never carries the bandwidth.

The same shape works with S3 presigned URLs, a signed CDN path, or your own file server. What matters is that the credential and the storage handle are different things, and that the component holding the storage handle checks the credential itself.

## Verify the visit, not just the token

A subtle failure mode: the token is cryptographically perfect but the underlying visit was reversed as fraudulent ten minutes ago.

So check the visit state at redemption, not only at issuance. If the visit is no longer marked complete, refuse. This is what makes retroactive fraud enforcement actually work end to end — otherwise your fraud engine reverses the *payment* while the *file* still goes out.

## Handle the platform's constraints

Telegram caps a bot deep-link \`start\` payload at 64 characters, and a signed token is longer than that. Store the token server-side under a short random handle and pass the handle:

\`\`\`
https://t.me/YourBot?start=aG7kQ2mZ9pLx
\`\`\`

The handle is a lookup key with its own short expiry, not a credential. This is a nice property in itself: the thing in the URL bar is useless on its own, and the actual token never appears anywhere a visitor can copy it.

## Failure modes to design for

**Expired token.** Say so plainly and tell them how to get a new one. Do not show a generic error — they will assume the file is gone.

**Use limit hit.** Distinguish this from expiry in the message. They are different problems with different fixes.

**File removed.** Files get taken down after a DMCA notice or moderation review. Say that, rather than pretending the token is bad.

**Delivery layer offline.** Your bot token can be revoked, your storage can rate-limit you. Detect it and tell the visitor it is your problem, not theirs.

Every one of these is a real thing that happens weekly at any volume, and the difference between a clear message and a generic failure is most of your support load.`,
  },
];

module.exports = { ALL };
