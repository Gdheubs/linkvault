'use strict';

/**
 * Telegram media bot.
 *
 * Two jobs:
 *  1. Storage  — a publisher forwards/uploads a file to the bot; the bot records
 *                the file_id in `resources` and hands back a resource id that a
 *                short link can point at. Telegram keeps the bytes.
 *  2. Delivery — after a visitor completes the monetization flow the platform
 *                issues a signed completion token. The visitor opens the bot with
 *                that token as a deep-link payload; the bot verifies it and sends
 *                the file. The file itself never gets a public URL.
 *
 * Everything degrades gracefully when TELEGRAM_BOT_TOKEN is unset: link creation
 * still works for plain destination URLs, and the delivery page falls back to a
 * direct redirect.
 */

const config = require('../config');
const { q } = require('../db');
const { now, randomToken } = require('./util');

const API = (method) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

async function call(method, body, { timeoutMs = 15000 } = {}) {
  if (!config.telegram.enabled) {
    return { ok: false, description: 'Telegram bot is not configured (TELEGRAM_BOT_TOKEN missing).' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({ ok: false, description: 'Bad JSON from Telegram' }));
    if (!json.ok) console.warn(`[telegram] ${method} failed:`, json.description);
    return json;
  } catch (err) {
    console.warn(`[telegram] ${method} error:`, err.message);
    return { ok: false, description: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const sendMessage = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

/** Re-send a stored file to a chat by its Telegram file_id. */
function sendResource(chatId, resource, caption = '') {
  const method = {
    document: 'sendDocument', video: 'sendVideo', photo: 'sendPhoto', audio: 'sendAudio',
  }[resource.kind] || 'sendDocument';
  const field = { sendDocument: 'document', sendVideo: 'video', sendPhoto: 'photo', sendAudio: 'audio' }[method];
  return call(method, {
    chat_id: chatId,
    [field]: resource.tg_file_id,
    caption: caption.slice(0, 1000),
    parse_mode: 'HTML',
  });
}

/** Pull a file descriptor out of any of the message shapes we accept. */
function extractFile(msg) {
  if (!msg) return null;
  if (msg.document) {
    const d = msg.document;
    return { kind: 'document', tg_file_id: d.file_id, tg_unique_id: d.file_unique_id, file_name: d.file_name || 'file', mime: d.mime_type || '', size_bytes: d.file_size || 0 };
  }
  if (msg.video) {
    const v = msg.video;
    return { kind: 'video', tg_file_id: v.file_id, tg_unique_id: v.file_unique_id, file_name: v.file_name || 'video.mp4', mime: v.mime_type || 'video/mp4', size_bytes: v.file_size || 0 };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { kind: 'audio', tg_file_id: a.file_id, tg_unique_id: a.file_unique_id, file_name: a.file_name || 'audio.mp3', mime: a.mime_type || 'audio/mpeg', size_bytes: a.file_size || 0 };
  }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { kind: 'photo', tg_file_id: p.file_id, tg_unique_id: p.file_unique_id, file_name: 'photo.jpg', mime: 'image/jpeg', size_bytes: p.file_size || 0 };
  }
  return null;
}

function saveResource(userId, file, messageId = null) {
  const existing = file.tg_unique_id
    ? q.get('SELECT * FROM resources WHERE user_id = ? AND tg_unique_id = ?', userId, file.tg_unique_id)
    : null;
  if (existing) return existing;

  const res = q.run(
    `INSERT INTO resources (user_id, tg_file_id, tg_unique_id, tg_message_id, kind, file_name, mime, size_bytes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    userId, file.tg_file_id, file.tg_unique_id || null, messageId,
    file.kind, file.file_name, file.mime, file.size_bytes, now(),
  );
  return q.get('SELECT * FROM resources WHERE id = ?', Number(res.lastInsertRowid));
}

/**
 * Link a Telegram chat to a platform account. The publisher gets a one-time
 * code in the dashboard and sends `/start <code>` to the bot.
 */
const pairing = new Map(); // code -> { userId, expires }

function newPairingCode(userId) {
  const code = randomToken(8);
  pairing.set(code, { userId, expires: now() + 15 * 60000 });
  for (const [k, v] of pairing) if (v.expires < now()) pairing.delete(k);
  return code;
}

function consumePairingCode(code) {
  const entry = pairing.get(code);
  if (!entry || entry.expires < now()) return null;
  pairing.delete(code);
  return entry.userId;
}

/** Deep link a visitor uses to collect their file: t.me/<bot>?start=<token>. */
function deliveryLink(completionToken) {
  if (!config.telegram.botUsername) return null;
  // Telegram caps the start payload at 64 chars, so store the token and pass a handle.
  const handle = randomToken(12);
  deliveryHandles.set(handle, { token: completionToken, expires: now() + 30 * 60000 });
  for (const [k, v] of deliveryHandles) if (v.expires < now()) deliveryHandles.delete(k);
  return { url: `https://t.me/${config.telegram.botUsername}?start=${handle}`, handle };
}

const deliveryHandles = new Map();
function resolveDeliveryHandle(handle) {
  const entry = deliveryHandles.get(handle);
  if (!entry || entry.expires < now()) return null;
  return entry.token;
}

async function setWebhook(baseUrl) {
  if (!config.telegram.enabled) return { ok: false, description: 'bot not configured' };
  return call('setWebhook', {
    url: `${baseUrl}/webhooks/telegram`,
    secret_token: config.telegram.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  });
}

async function getMe() {
  return call('getMe');
}

module.exports = {
  call, sendMessage, sendResource, extractFile, saveResource,
  newPairingCode, consumePairingCode, deliveryLink, resolveDeliveryHandle,
  setWebhook, getMe,
  get enabled() { return config.telegram.enabled; },
};
