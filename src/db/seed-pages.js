'use strict';

/**
 * Policy page templates.
 *
 * These are a STARTING POINT, not legal advice. Every ad network review expects
 * to find a real Privacy policy, Terms, Cookie policy, DMCA process, Disclaimer
 * and About page reachable from the footer — these give you all six, wired up
 * and editable from Admin → Content → Policy pages.
 *
 * Read them, fill in the bracketed placeholders, and have them reviewed for your
 * jurisdiction before you go live.
 */

function build(config) {
  const B = config.brand.name;
  const CO = config.brand.company;
  const SUPPORT = config.brand.supportEmail;
  const DMCA = config.brand.dmcaEmail;
  const HOST = config.baseUrl.replace(/^https?:\/\//, '');
  const ADDRESS = config.brand.address || '[Your registered business address]';

  return [
    {
      slug: 'about',
      title: `About ${B}`,
      body: `# About ${B}

${B} is a link monetization platform operated by ${CO}. Publishers create a short link for a URL or a stored file, share it, and earn a share of the advertising revenue that link generates.

## What we actually do

Three things, and we try to do each of them honestly.

**We route traffic.** Every visit to a ${B} short link passes through a monetization flow — a short, configurable sequence of pages carrying editorial content and advertising — before reaching its destination.

**We score traffic.** Not every visit is a person. Our anti-fraud engine evaluates each visit against a published set of signals: automation markers, request timing, interaction evidence, IP behaviour, and publisher-level patterns. Traffic that fails scoring still reaches its destination; it simply is not paid for. We think that is the right trade-off — visitors are never punished to protect revenue.

**We deliver files.** Files published through ${B} are stored in a private Telegram vault rather than a public bucket. There is no guessable URL, no directory to walk, and no way to reach the file without a signed, expiring token issued at the end of a completed visit.

## Who this is for

Publishers who share files or links at volume and want to earn from that traffic without running their own ad stack, fraud detection and payout infrastructure.

## Who this is not for

Anyone planning to send bot traffic, buy clicks, or use traffic exchanges. The fraud engine is not decorative, invalid traffic earns nothing, and sustained invalid traffic gets accounts suspended with balances reversed.

## Contact

General and support enquiries: ${SUPPORT}
Copyright and DMCA: ${DMCA}
Postal: ${ADDRESS}
`,
    },

    {
      slug: 'privacy',
      title: 'Privacy Policy',
      body: `# Privacy Policy

This policy explains what ${B} ("we", "us"), operated by ${CO}, collects, why, and what you can do about it. It covers ${HOST} and every short link served from it.

**Effective date:** [insert date] · **Last reviewed:** [insert date]

## 1. Who is the data controller

${CO}, ${ADDRESS}. For privacy questions, contact ${SUPPORT}.

## 2. What we collect

### 2.1 From publishers (people with an account)

- **Account data** — email address, display name, and a password stored only as a salted scrypt hash. We never store your password.
- **Payout data** — the payout method and address you choose to provide.
- **Session data** — a session identifier, a hashed IP address, and the user-agent string of each device you sign in from.
- **Usage data** — links you create, files you store, and the aggregate performance of both.

### 2.2 From visitors (people who open a short link)

- **A hashed IP address.** We hash IPs with a secret salt before storage. We do not retain raw IP addresses in the database.
- **User-agent string**, and the device, browser and operating system derived from it.
- **Country**, derived from a header supplied by our CDN. We do not derive city-level or precise location.
- **Referring URL**, if your browser sends one.
- **Interaction telemetry** — time on each step, whether the tab held focus, and whether pointer or keyboard input occurred. This exists to distinguish people from scripts.
- **A device fingerprint hash** — a one-way hash of coarse browser characteristics (screen size, timezone, language list, hardware concurrency). It is used for duplicate-session detection and cannot be reversed into an identity.

### 2.3 What we do not collect

We do not collect names, precise location, contact details, payment card data, or any special-category data from visitors. We do not read the contents of files stored in the vault.

## 3. Why we process it

| Purpose | Lawful basis (GDPR Art. 6) |
| --- | --- |
| Operating your account | Contract |
| Fraud prevention and traffic scoring | Legitimate interests |
| Calculating and paying earnings | Contract |
| Serving advertising | Consent, where required |
| Security and abuse handling | Legitimate interests |
| Legal and tax record-keeping | Legal obligation |

Our legitimate interest in fraud prevention is straightforward: without it, advertisers cannot trust the inventory and honest publishers do not get paid.

## 4. Cookies and similar technologies

We set a small number of first-party cookies. They are itemised in our [Cookie Policy](/cookies). None of them are used for cross-site behavioural profiling by us.

Advertising served on this site may set its own cookies and identifiers, which are controlled by the ad network, not by us. See section 5.

## 5. Advertising and third parties

We display advertising to fund the service. Where Google AdSense is enabled on this deployment:

- Google and its partners may use cookies to serve ads based on prior visits to this or other websites.
- Google's use of advertising cookies enables it and its partners to serve ads based on your visit to our site and other sites.
- You can opt out of personalised advertising by visiting [Google Ads Settings](https://www.google.com/settings/ads), and out of third-party vendor cookies via [aboutads.info](https://www.aboutads.info/choices/) or [youronlinechoices.eu](https://www.youronlinechoices.eu/).
- Google's own handling of your data is governed by the [Google Privacy Policy](https://policies.google.com/privacy) and the [Google Advertising Policies](https://policies.google.com/technologies/ads).

Where required by law, we request consent before non-essential advertising cookies are set.

**Telegram.** Files published through ${B} are stored on Telegram's infrastructure and delivered by a Telegram bot. If you collect a file, your interaction with that bot is subject to [Telegram's Privacy Policy](https://telegram.org/privacy). We receive only your Telegram chat ID, and only so the bot can reply to you.

## 6. How long we keep it

- **Raw visit records** — up to 180 days, then deleted. Aggregate daily statistics are retained without any per-visitor data.
- **Account data** — for as long as your account exists, then deleted or anonymised within 90 days of closure.
- **Financial records** — retained as long as tax and accounting law requires, typically six to seven years.
- **Sessions** — expire automatically; you can revoke them all from Settings.

## 7. Your rights

If you are in the EEA, UK, or another jurisdiction granting equivalent rights, you can request access, correction, erasure, restriction, portability, or object to processing based on legitimate interests. Where processing rests on consent, you can withdraw it at any time.

Write to ${SUPPORT}. We respond within 30 days. You also have the right to complain to your local supervisory authority.

**California residents:** you may request disclosure of the categories of personal information collected and request deletion. We do not sell personal information as that term is defined by the CCPA/CPRA.

## 8. Security

Passwords are hashed with scrypt. IP addresses and fingerprints are hashed with a secret salt. Sessions are httpOnly and SameSite-restricted. Administrative actions are written to an audit log. We use TLS in transit.

No system is perfectly secure. If you find a vulnerability, please report it to ${SUPPORT} before disclosing it publicly.

## 9. Children

This service is not directed at children under 13 (or under 16 in the EEA), and we do not knowingly collect their data. If you believe a child has provided us data, contact ${SUPPORT} and we will delete it.

## 10. International transfers

Our infrastructure and our advertising and storage partners may process data outside your country. Where required, transfers rely on Standard Contractual Clauses or an adequacy decision.

## 11. Changes

We will post any material change on this page and update the "Last reviewed" date. Continued use after a change means you accept the revised policy.

## 12. Contact

${CO}
${ADDRESS}
${SUPPORT}
`,
    },

    {
      slug: 'terms',
      title: 'Terms of Service',
      body: `# Terms of Service

These terms govern your use of ${B}, operated by ${CO}. By creating an account or using a ${B} link, you accept them.

**Effective date:** [insert date]

## 1. Accounts

You must be at least 18, or the age of majority where you live, to hold a publisher account. One person, one account. You are responsible for everything that happens under your credentials.

Provide accurate information. Accounts created with false details may be suspended and balances withheld.

## 2. Acceptable use

You may **not** use ${B} to distribute or link to:

- Content that infringes copyright, trademark, or any other right you do not hold
- Malware, phishing pages, or anything designed to deceive or harm a visitor
- Child sexual abuse material — reported to authorities without notice
- Content that is illegal in your jurisdiction or ours
- Adult content, gambling, or pharmaceutical content where our ad partners prohibit it
- Content promoting violence, terrorism, or targeted harassment

You may **not**:

- Send bot, automated, incentivised, or purchased traffic
- Use traffic exchanges, auto-surf services, or paid-to-click networks
- Click your own links, or arrange for others to do so, to generate revenue
- Attempt to bypass, script, or automate the monetization flow
- Create multiple accounts to evade limits, referral rules, or a suspension
- Scrape, reverse-engineer, or attack the service or its API

## 3. Traffic quality and earnings

**Earnings are calculated on valid traffic only.** Whether traffic is valid is determined by our anti-fraud engine, applying the signals described on our public fraud documentation. Its determination is final for the purpose of these terms, though you may request a review.

Specifically:

- A visit scoring at or above the rejection threshold earns nothing.
- A visit scoring in the review band is paid at a reduced rate.
- Earnings sit in a pending state for a hold window before becoming withdrawable, so that fraud sweeps can reverse them.
- Earnings determined to have come from invalid traffic may be reversed at any time, including after withdrawal has been requested.

We publish rate cards as **estimates for planning**. They are not a guarantee of earnings. Actual revenue depends on advertiser demand, fill rate, ad network behaviour, seasonality, and above all the quality of your traffic.

## 4. Payouts

Withdrawals are available above the published minimum. Requests are reviewed before settlement; review may include a traffic-quality check.

We may withhold or delay a payout where we have a reasonable belief that the underlying traffic was invalid, that the account has breached these terms, or that we are legally required to. Where we withhold a payout we will tell you why.

You are responsible for any tax arising on your earnings. We do not withhold tax on your behalf unless legally required to.

## 5. Your content

You keep ownership of everything you upload or link to. You grant us a limited licence to store, transmit and display it strictly to operate the service.

You warrant that you have the rights to everything you publish through ${B}, and you indemnify us against claims arising from it.

## 6. Removal and moderation

We may disable a link, quarantine a file, or suspend an account where content breaches section 2, where we receive a valid legal notice, or where an ad partner requires it. We will normally tell you which rule was breached.

## 7. Availability

The service is provided "as is". We do not guarantee uninterrupted availability, and we may change or discontinue features. We will give reasonable notice of a material change where we can.

## 8. Limitation of liability

To the maximum extent the law allows, ${CO} is not liable for indirect, incidental, special, or consequential loss, or for lost profits or lost data. Our total aggregate liability is limited to the greater of (a) the amount we paid you in the twelve months before the claim, or (b) USD 100.

Nothing here excludes liability that cannot lawfully be excluded.

## 9. Termination

You may close your account at any time. Balances above the minimum payout, earned from valid traffic, remain payable.

We may terminate an account for a material breach of these terms. Where termination follows a fraud finding, balances derived from that fraud are forfeited.

## 10. Changes

We may update these terms. Material changes will be announced on the site. Continued use after the effective date means you accept the change.

## 11. Governing law

These terms are governed by the laws of [insert jurisdiction], and the courts of [insert jurisdiction] have exclusive jurisdiction, without prejudice to any mandatory consumer protections in your country of residence.

## 12. Contact

${SUPPORT}
`,
    },

    {
      slug: 'cookies',
      title: 'Cookie Policy',
      body: `# Cookie Policy

This page lists every cookie ${B} sets, and explains what third-party advertising may set alongside them.

## Cookies we set

| Name | Purpose | Type | Lifetime |
| --- | --- | --- | --- |
| \`lv_sid\` | Keeps you signed in | Strictly necessary | Session TTL (default 30 days) |
| \`lv_csrf\` | Blocks cross-site request forgery on forms | Strictly necessary | 24 hours |
| \`lv_flash\` | Carries a one-off status message across a redirect | Strictly necessary | 20 seconds |
| \`lv_v\` | Ties a visit to its monetization flow so progress is not lost | Strictly necessary | 1 hour |
| \`lv_p\` | Records that the browser ran our anti-fraud probe | Strictly necessary | 1 hour |

All five are first-party, and all five are required for the site to function. None of them profile you across other websites.

We also use **localStorage** for your colour-theme choice, and **sessionStorage** to cap how often a promotional popup appears. Neither is transmitted to us.

## Third-party cookies

### Advertising

Where advertising is enabled on this deployment, the ad network sets its own cookies and identifiers, which we neither control nor can enumerate here.

If Google AdSense is enabled:

- Google and its partners may use cookies to serve ads based on your prior visits to this and other sites.
- Opt out of personalised advertising at [Google Ads Settings](https://www.google.com/settings/ads).
- Opt out of many other vendors at [aboutads.info](https://www.aboutads.info/choices/) or [youronlinechoices.eu](https://www.youronlinechoices.eu/).
- Google's practices are described in the [Google Privacy Policy](https://policies.google.com/privacy).

### Embedded video

Video embeds use \`youtube-nocookie.com\`, YouTube's privacy-enhanced mode, which does not set tracking cookies until you actually play the video.

### Analytics

If site analytics are enabled by the operator, that provider sets its own cookies under its own policy.

## Managing cookies

Every major browser lets you block or delete cookies. Blocking our strictly-necessary cookies will break sign-in and the monetization flow — links will stop working correctly.

Where the law requires consent for non-essential cookies, we ask before setting them.

## Questions

${SUPPORT}
`,
    },

    {
      slug: 'dmca',
      title: 'DMCA & Copyright Policy',
      body: `# DMCA & Copyright Policy

${CO} respects copyright and responds to properly submitted notices under the Digital Millennium Copyright Act (17 U.S.C. § 512) and equivalent legislation elsewhere.

## Reporting infringement

Send a notice to **${DMCA}**, or use our [contact form](/contact?kind=dmca) with the type set to "DMCA / copyright notice".

### Your notice must include

1. A physical or electronic signature of the copyright owner, or a person authorised to act for them.
2. Identification of the copyrighted work claimed to have been infringed.
3. **The specific ${B} short-link code or full URL** you are complaining about. We cannot act on a general complaint about the site — we need the link.
4. Your name, postal address, telephone number and email address.
5. A statement that you have a good-faith belief that the use is not authorised by the copyright owner, its agent, or the law.
6. A statement that the information in the notice is accurate, and **under penalty of perjury**, that you are authorised to act on behalf of the owner.

Incomplete notices delay action. Please include all six elements.

### What happens next

We aim to review complete notices within **two business days**. Where a notice is valid we disable the link, quarantine any associated stored file, and notify the publisher with a copy of the notice.

## Counter-notification

If your content was removed and you believe it was a mistake or misidentification, send a counter-notice to ${DMCA} containing:

1. Your physical or electronic signature.
2. Identification of the removed material and where it appeared before removal.
3. A statement **under penalty of perjury** that you have a good-faith belief the material was removed as a result of mistake or misidentification.
4. Your name, address and telephone number.
5. A statement consenting to the jurisdiction of the federal district court for your address (or, if outside the United States, any district in which we may be found), and that you will accept service of process from the complainant.

We may restore the material 10 to 14 business days after forwarding your counter-notice, unless the complainant tells us they have filed a court action.

## Repeat infringers

We terminate the accounts of repeat infringers. A publisher who accumulates multiple valid notices will have their account closed and their remaining balance withheld pending review.

## Misrepresentation

Section 512(f) makes it unlawful to knowingly and materially misrepresent that material is infringing. Bad-faith notices carry liability for damages, including costs and legal fees.

## Designated agent

Copyright Agent, ${CO}
${ADDRESS}
${DMCA}
`,
    },

    {
      slug: 'disclaimer',
      title: 'Disclaimer',
      body: `# Disclaimer

## Earnings

**${B} makes no earnings guarantee.** Any figure shown on this site — rate cards, calculators, example dashboards, screenshots — is an illustration for planning, not a promise.

Actual earnings depend on factors largely outside our control:

- The country and device mix of your visitors
- Where your traffic comes from and how engaged it is
- Advertiser demand and seasonality in your traffic's markets
- The fill rate of the ad network serving your inventory
- Above all, whether your traffic is real

Two publishers with identical click counts routinely earn very different amounts. The realised eCPM on your own dashboard is the only number that describes your account.

Published third-party comparisons of short-link platform rates are inconsistent with each other and are frequently marketing material. Treat them, and us, with appropriate scepticism, and validate against your own measured results.

## Third-party content

${B} links to destinations chosen by publishers, and displays advertising selected by ad networks. We do not endorse, control, or vouch for either. Follow a link or an ad at your own risk, and read the destination's own terms and privacy policy.

## Files

Files delivered through ${B} are uploaded by publishers, not by us. We do not inspect their contents before delivery. If you believe a file infringes your rights or is otherwise unlawful, report it via our [DMCA process](/dmca) or the [contact form](/contact).

## No professional advice

Nothing on this site — including the blog — is legal, financial, tax, or professional advice. The policy templates provided to operators of this software are a starting point and are not legal advice. Consult a qualified professional for your situation.

## Availability

The service is provided "as is" and "as available", without warranty of any kind to the extent the law allows.

## Questions

${SUPPORT}
`,
    },
  ];
}

module.exports = { build };
