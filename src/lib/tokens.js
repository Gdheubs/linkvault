'use strict';

/**
 * Compact HMAC-signed tokens: base64url(payloadJSON) + "." + base64url(HMAC-SHA256).
 *
 * Used for two things:
 *   - step tokens      : carry gateway progress so the flow cannot be skipped by URL edits
 *   - completion tokens: prove a visit finished, and are what the media bot verifies
 *                        before it releases a file from Telegram storage.
 */

const crypto = require('crypto');
const config = require('../config');
const { q } = require('../db');
const { randomToken, nowSec, now } = require('./util');

function sign(payload, secret = config.secrets.token) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret = config.secrets.token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- step tokens -------------------------------------------------------------

/**
 * @param {object} o
 * @param {number} o.visitId
 * @param {number} o.linkId
 * @param {number} o.step      1-based index of the step this token unlocks
 * @param {number} o.steps     total step count for the campaign
 * @param {string} o.nonce     rotates every step so a token can't be replayed forward
 */
function issueStepToken({ visitId, linkId, step, steps, nonce }) {
  return sign({
    t: 'step',
    v: visitId,
    l: linkId,
    s: step,
    n: steps,
    x: nonce,
    iat: nowSec(),
    exp: nowSec() + config.monetization.stepTokenTtlSec,
  });
}

function readStepToken(token) {
  const p = verify(token);
  if (!p || p.t !== 'step') return null;
  return { visitId: p.v, linkId: p.l, step: p.s, steps: p.n, nonce: p.x, iat: p.iat };
}

// --- completion tokens -------------------------------------------------------

/**
 * Persisted so it can be single-use-ish (capped uses) and revoked by a later
 * fraud sweep even though the signature itself stays valid.
 */
function issueCompletionToken({ visitId, linkId, resourceId = null, code = '' }) {
  const jti = randomToken(16);
  const exp = nowSec() + config.monetization.completionTokenTtlSec;
  q.run(
    'INSERT INTO completion_tokens (jti, visit_id, link_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    jti, visitId, linkId, now(), exp * 1000,
  );
  return sign({ t: 'done', j: jti, v: visitId, l: linkId, r: resourceId, c: code, iat: nowSec(), exp });
}

/**
 * @returns {{ok:true, payload:object, record:object} | {ok:false, reason:string}}
 */
function redeemCompletionToken(token, { consume = true } = {}) {
  const p = verify(token);
  if (!p || p.t !== 'done') return { ok: false, reason: 'invalid_or_expired' };

  const rec = q.get('SELECT * FROM completion_tokens WHERE jti = ?', p.j);
  if (!rec) return { ok: false, reason: 'unknown_token' };
  if (rec.expires_at < now()) return { ok: false, reason: 'expired' };
  if (rec.use_count >= config.monetization.completionMaxUses) {
    return { ok: false, reason: 'use_limit_reached' };
  }

  const visit = q.get('SELECT * FROM visits WHERE id = ?', rec.visit_id);
  if (!visit) return { ok: false, reason: 'visit_missing' };
  if (!visit.is_completed) return { ok: false, reason: 'visit_incomplete' };

  if (consume) {
    q.run(
      'UPDATE completion_tokens SET use_count = use_count + 1, used_at = COALESCE(used_at, ?) WHERE jti = ?',
      now(), p.j,
    );
  }
  return { ok: true, payload: p, record: rec, visit };
}

function sweepTokens() {
  q.run('DELETE FROM completion_tokens WHERE expires_at < ?', now() - 86400000);
}

module.exports = {
  sign, verify,
  issueStepToken, readStepToken,
  issueCompletionToken, redeemCompletionToken, sweepTokens,
};
