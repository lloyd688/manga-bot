'use strict';
const { Telegraf } = require('telegraf');
const express      = require('express');
const db           = require('./db');
const handlers     = require('./handlers');
const scheduler    = require('./scheduler');

const TOKEN   = process.env.BOT_TOKEN;
const PORT    = parseInt(process.env.PORT || '3000', 10);
// Railway provides RAILWAY_STATIC_URL or set WEBHOOK_URL manually
const WEBHOOK_DOMAIN = process.env.WEBHOOK_URL || (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null);

if (!TOKEN) { console.error('BOT_TOKEN is required'); process.exit(1); }

const bot = new Telegraf(TOKEN);

// pass bot to handlers module (for sending messages outside ctx)
handlers.setup(bot);

// ── Commands ──────────────────────────────────────────────────────────────────
bot.command('start',        handlers.startCommand);
bot.command('settopic',     handlers.settopicCommand);
bot.command('setgroup',     handlers.setgroupCommand);
bot.command('dayoff',       handlers.dayoffCommand);
bot.command('board',        handlers.boardCommand);
bot.command('postcheckin',  handlers.postcheckinCommand);
bot.command('postdayoff',   handlers.postdayoffCommand);
bot.command('alljobs',      handlers.alljobsCommand);
bot.command('teamstats',    handlers.teamstatsCommand);
bot.command('admin',        handlers.adminCommand);
bot.command('fixclaims',    handlers.fixclaimsCommand);
bot.command('dbinfo',       handlers.dbinfoCommand);
bot.command('users',        handlers.usersCommand);
bot.command('resetclaim',   handlers.resetclaimCommand);
bot.command('addchapters',  handlers.addchaptersCommand);
bot.command('topics',       handlers.topicsCommand);
bot.command('testnotify',   handlers.testNotifyCommand);

// ── Messages & Callbacks ──────────────────────────────────────────────────────
bot.on('message',        handlers.messageHandler);
bot.on('callback_query', handlers.callbackHandler);

// ── Express + Webhook ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const secretPath = `/webhook/${TOKEN.replace(/[^a-zA-Z0-9]/g, '_')}`;
app.post(secretPath, async (req, res) => {
  try { await bot.handleUpdate(req.body, res); }
  catch (e) { console.error('handleUpdate error:', e.message); res.sendStatus(200); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  db.init();

  if (WEBHOOK_DOMAIN) {
    const webhookUrl = `${WEBHOOK_DOMAIN}${secretPath}`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log('Webhook set:', webhookUrl);
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
    scheduler.setup(bot);
  } else {
    // local dev: polling
    console.log('No WEBHOOK_URL — starting polling (dev mode)');
    await bot.telegram.deleteWebhook();
    app.listen(PORT, () => console.log(`Health check on port ${PORT}`));
    scheduler.setup(bot);
    await bot.launch();
  }
}

main().catch(e => { console.error('Startup error:', e); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
