'use strict';

/**
 * Telegram bot webhook.
 *
 * Commands:
 *   /start                 greeting + how to use
 *   /start <pair-code>     link this chat to a publisher account
 *   /start <handle>        redeem a delivery handle -> verify token -> send the file
 *   /link                  show the pairing instructions again
 *   /files                 list this publisher's stored files
 *   /help
 *   <any file upload>      store it in the vault and return a resource id
 */

const express = require('express');
const config = require('../config');
const { q } = require('../db');
const telegram = require('../lib/telegram');
const tokens = require('../lib/tokens');
const { fmtBytes, escapeHtml, timingSafeEqual } = require('../lib/util');

const router = express.Router();

router.post('/telegram', express.json({ limit: '256kb' }), async (req, res) => {
  const secret = req.get('x-telegram-bot-api-secret-token') || '';
  if (!secret || !timingSafeEqual(secret, config.telegram.webhookSecret)) {
    return res.status(401).json({ ok: false });
  }
  // Always 200 fast — Telegram retries on anything else.
  res.json({ ok: true });

  try {
    await handleUpdate(req.body || {});
  } catch (err) {
    console.error('[telegram] update handler failed:', err);
  }
});

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.chat) return;

  const chatId = String(msg.chat.id);
  const text = String(msg.text || '').trim();
  const user = q.get('SELECT * FROM users WHERE tg_chat_id = ?', chatId);

  // --- /start with a payload ---
  if (text.startsWith('/start')) {
    const payload = text.slice(6).trim();
    if (!payload) return void greet(chatId, user);

    // 1. delivery handle?
    const token = telegram.resolveDeliveryHandle(payload);
    if (token) return void deliver(chatId, token);

    // 2. account pairing code?
    const pairedUserId = telegram.consumePairingCode(payload);
    if (pairedUserId) {
      q.run('UPDATE users SET tg_chat_id = ? WHERE id = ?', chatId, pairedUserId);
      const u = q.get('SELECT email FROM users WHERE id = ?', pairedUserId);
      return void telegram.sendMessage(
        chatId,
        `✅ <b>Account linked.</b>\n\nThis chat is now connected to <code>${escapeHtml(u.email)}</code>.\n\nSend me any file and I will store it in your vault and hand you a resource ID you can attach to a short link.`,
      );
    }

    return void telegram.sendMessage(
      chatId,
      '⚠️ That code is expired or invalid.\n\nIf you were collecting a file, go back and open the unlock page again — download tokens are short-lived on purpose.',
    );
  }

  if (text === '/help' || text === '/link') {
    return void greet(chatId, user);
  }

  if (text === '/files') {
    if (!user) return void telegram.sendMessage(chatId, 'Link your account first — open the File vault page in your dashboard and press "Connect Telegram".');
    const files = q.all(
      "SELECT id, file_name, kind, size_bytes FROM resources WHERE user_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 20",
      user.id,
    );
    if (!files.length) return void telegram.sendMessage(chatId, 'Your vault is empty. Send me a file to store one.');
    const lines = files.map((f) => `• <code>#${f.id}</code> ${escapeHtml(f.file_name)} <i>(${fmtBytes(f.size_bytes)})</i>`);
    return void telegram.sendMessage(chatId, `<b>Your vault — ${files.length} most recent</b>\n\n${lines.join('\n')}`);
  }

  // --- file upload ---
  const file = telegram.extractFile(msg);
  if (file) {
    if (!user) {
      return void telegram.sendMessage(
        chatId,
        '🔒 I do not know who you are yet.\n\nOpen <b>Dashboard → File vault → Connect Telegram</b> and send me the pairing command it shows you. Then re-send this file.',
      );
    }
    const resource = telegram.saveResource(user.id, file, msg.message_id);
    return void telegram.sendMessage(
      chatId,
      `📦 <b>Stored in your vault.</b>\n\n<b>File:</b> ${escapeHtml(resource.file_name)}\n<b>Size:</b> ${fmtBytes(resource.size_bytes)}\n<b>Resource ID:</b> <code>${resource.id}</code>\n\nAttach it to a monetized link from <b>Dashboard → My links → Create link</b>, or via the API with <code>{"resource_id": ${resource.id}}</code>.`,
    );
  }

  if (text) return void greet(chatId, user);
}

function greet(chatId, user) {
  const lines = [
    `👋 <b>${escapeHtml(config.brand.name)} media bot</b>`,
    '',
    'I do two things:',
    '• <b>Store</b> files you send me, so a monetized short link can deliver them.',
    '• <b>Deliver</b> a file to a visitor once they finish a link flow and I can verify their signed token.',
    '',
  ];
  if (user) {
    lines.push(`You are signed in as <code>${escapeHtml(user.email)}</code>. Send me any file to add it to your vault, or use /files to list what is stored.`);
  } else {
    lines.push('This chat is not linked to an account yet. Open <b>Dashboard → File vault → Connect Telegram</b> and follow the pairing step.');
  }
  return telegram.sendMessage(chatId, lines.join('\n'));
}

async function deliver(chatId, token) {
  const result = tokens.redeemCompletionToken(token, { consume: true });
  if (!result.ok) {
    return telegram.sendMessage(
      chatId,
      `⛔ <b>Could not verify that download.</b>\n\nReason: <code>${escapeHtml(result.reason)}</code>\n\nOpen the short link again to get a fresh token.`,
    );
  }

  const link = q.get('SELECT * FROM links WHERE id = ?', result.record.link_id);
  if (!link || !link.resource_id) {
    return telegram.sendMessage(chatId, '⛔ That link has no file attached to it.');
  }

  const resource = q.get('SELECT * FROM resources WHERE id = ?', link.resource_id);
  if (!resource || resource.status !== 'ready') {
    return telegram.sendMessage(chatId, '⛔ This file was removed or is under moderation review.');
  }

  const sent = await telegram.sendResource(
    chatId,
    resource,
    `✅ <b>${escapeHtml(link.title || resource.file_name)}</b>\n\nDelivered by ${escapeHtml(config.brand.name)}.`,
  );

  if (sent.ok) {
    q.run('UPDATE resources SET downloads = downloads + 1 WHERE id = ?', resource.id);
  } else {
    await telegram.sendMessage(chatId, `⛔ Telegram refused to send the file: <code>${escapeHtml(sent.description || 'unknown error')}</code>`);
  }
}

module.exports = router;
