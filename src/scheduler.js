'use strict';
const cron = require('node-cron');
const db   = require('./db');
const h    = require('./handlers');

const ADMIN_ID    = parseInt(process.env.ADMIN_ID || '0', 10);
const DAILY_TARGET = 12;
const TZ = 'Asia/Bangkok';

// ── helpers ───────────────────────────────────────────────────────────────────

function _groupId() { return h.groupId(); }
function _topicId(k) { return h.topicId(k); }

async function _sendLong(bot, chatId, text, extra = {}) {
  const MAX = 4096;
  if (text.length <= MAX) { await bot.telegram.sendMessage(chatId, text, extra); return; }
  const lines = text.split('\n');
  const chunks = [];
  let buf = [], bufLen = 0;
  for (const line of lines) {
    const need = line.length + 1;
    if (bufLen + need > MAX && buf.length) { chunks.push(buf.join('\n')); buf = []; bufLen = 0; }
    buf.push(line); bufLen += need;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  for (const chunk of chunks) await bot.telegram.sendMessage(chatId, chunk, extra);
}

function _workingDaysInMonth(year, month, dayOff) {
  const days = new Date(year, month, 0).getDate(); // days in month
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const wd = new Date(year, month - 1, d).getDay(); // 0=Sun
    const pyWd = wd === 0 ? 6 : wd - 1; // Mon=0
    if (pyWd !== dayOff) count++;
  }
  return count;
}

// ── send_reminder (12:00 & 22:00) ────────────────────────────────────────────

async function sendReminder(bot) {
  const gid = _groupId();
  if (!gid) return;
  const now   = new Date();
  const today = h.bkkISODate(now);
  const wd    = h.bkkWeekday(now);
  const thaiDate = h.bkkThaiDate(now);

  const translators = db.getAllTranslatorSettings();
  const attByUid    = Object.fromEntries(db.getAllTodayAttendance(today).map(r => [r.user_id, r]));

  const lines = [
    '╔══════════════════════════╗',
    '║  📊  รายงานประจำวัน          ║',
    `║  ${thaiDate}  วัน${h.DAY_NAMES[wd]}${''.padEnd(10 - h.DAY_NAMES[wd].length)}║`,
    '╚══════════════════════════╝',
    '',
  ];

  let totalTodayAll = 0;

  for (const t of translators) {
    const uid  = t.user_id;
    const name = t.translator_name || String(uid);
    const bkk  = new Date(now.getTime() + 7 * 3600 * 1000);
    const monthCh = db.getCompletedChaptersInMonth(uid, bkk.getUTCFullYear(), bkk.getUTCMonth() + 1);

    if (wd === t.day_off) {
      lines.push(`🏖️  ${name}`, `    วันหยุดวัน${h.DAY_NAMES[t.day_off]}`, `    📅 รวมเดือนนี้:  ${monthCh} ตอน`, '─'.repeat(32));
      continue;
    }

    const todayCh = db.getCompletedChaptersOnDate(uid, today);
    totalTodayAll += todayCh;
    const dayIcon = todayCh >= DAILY_TARGET ? '✅' : '⚠️';
    const lackTxt = todayCh < DAILY_TARGET ? `  (ขาด ${DAILY_TARGET - todayCh} ตอน)` : '  (ครบเป้าแล้ว!)';

    const att = attByUid[uid];
    let ciTxt, coTxt, hrTxt;
    if (!att || !att.check_in_at) {
      ciTxt = '❓  ยังไม่เข้างาน'; coTxt = '—'; hrTxt = '—';
    } else if (!att.check_out_at) {
      const elapsed = (Date.now() + 7 * 3600 * 1000 - new Date(att.check_in_at + 'Z').getTime()) / 3600000;
      ciTxt = `🟢  ${h.displayTime(att.check_in_at)} น.`;
      coTxt = '⏳  ยังไม่ออกงาน';
      hrTxt = `${elapsed.toFixed(1)} ชม. (กำลังทำงาน)`;
    } else {
      const hours  = att.hours_worked || 0;
      ciTxt = `🟢  ${h.displayTime(att.check_in_at)} น.`;
      coTxt = `🔴  ${h.displayTime(att.check_out_at)} น.`;
      hrTxt = `${hours >= 8 ? '✅' : '⚠️'}  รวม ${hours.toFixed(1)} ชม.`;
    }

    lines.push(
      `${dayIcon}  ${name}`,
      `    🕐 เข้างาน:    ${ciTxt}`,
      `    🕐 ออกงาน:    ${coTxt}`,
      `    ⏱  ชั่วโมง:    ${hrTxt}`,
      `    📖 วันนี้:      ${todayCh} ตอน${lackTxt}`,
      `    📅 เดือนนี้:   ${monthCh} ตอน`,
      '─'.repeat(32),
    );
  }

  lines.push('', `📌  รวมทั้งทีมวันนี้:  ${totalTodayAll} ตอน`, '');

  const claims = db.getAllActiveClaims();
  if (claims.length) {
    lines.push('📦  งานที่กำลังแปลอยู่:');
    const byT = {};
    for (const cl of claims) { if (!byT[cl.translator_id]) byT[cl.translator_id] = []; byT[cl.translator_id].push(cl); }
    for (const [uid, uclms] of Object.entries(byT)) {
      const name = uclms[0].translator_name || String(uid);
      const totalCh = uclms.reduce((s,c) => s + c.chapter_count, 0);
      lines.push(`  👤 ${name}  (${totalCh} ตอน)`);
      for (const cl of uclms) {
        const rng = cl.chapter_count > 1 ? `ตอน ${cl.chapter_from}–${cl.chapter_to}` : `ตอน ${cl.chapter_from}`;
        lines.push(`      • ${cl.manga_title || cl.job_id}  —  ${rng}`);
      }
    }
  } else if (translators.length) {
    lines.push('✨  ไม่มีงานค้างอยู่');
  }

  const tid = _topicId('topic_report');
  const extra = tid ? { message_thread_id: tid } : {};
  await _sendLong(bot, gid, lines.join('\n'), extra);
}

// ── send_daily_summary (00:30) ────────────────────────────────────────────────

async function sendDailySummary(bot) {
  if (!ADMIN_ID) return;
  const now = new Date();
  const thaiDate = h.bkkThaiDate(now);
  const completed = db.getTodayCompletedJobs();
  const allClaims = db.getAllActiveClaims();
  const lines = [`📊 สรุปประจำวัน ${thaiDate}\n`, `✅ งานเสร็จวันนี้: ${completed.length} ชุด\n`, `🔄 งานที่กำลังแปลอยู่: ${allClaims.length} รายการ`];
  const byT = {};
  for (const cl of allClaims) { if (!byT[cl.translator_id]) byT[cl.translator_id] = []; byT[cl.translator_id].push(cl); }
  for (const clms of Object.values(byT)) {
    const name = clms[0].translator_name || String(clms[0].translator_id);
    lines.push(`  • ${name}: ${clms.reduce((s,c) => s + c.chapter_count, 0)} ตอน`);
  }
  await bot.telegram.sendMessage(ADMIN_ID, lines.join('\n'));
}

// ── send_monthly_summary (01:00 วันที่ 1) ────────────────────────────────────

async function sendMonthlySummary(bot) {
  const now = new Date();
  if (h.bkkISODate(now).slice(8) !== '01') return; // not day 1
  const bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  let yr = bkk.getUTCFullYear(), mo = bkk.getUTCMonth() + 1;
  if (mo === 1) { yr -= 1; mo = 12; } else { mo -= 1; }
  const thaiYr = yr + 543;
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const translators = db.getAllTranslatorSettings();
  if (!translators.length) return;

  const lines = [
    '╔══════════════════════════════╗',
    '║  📊  สรุปผลงานประจำเดือน        ║',
    `║  ${monthNames[mo-1]} ${thaiYr}${''.padEnd(18)}║`,
    '╚══════════════════════════════╝',
    '',
  ];

  let grandDone = 0, grandTarget = 0;
  for (const t of translators) {
    const uid      = t.user_id;
    const name     = t.translator_name || String(uid);
    const workDays = _workingDaysInMonth(yr, mo, t.day_off);
    const target   = workDays * DAILY_TARGET;
    const done     = db.getCompletedChaptersInMonth(uid, yr, mo);
    const pct      = target ? (done / target * 100) : 0;
    const medal    = pct >= 100 ? '🥇' : pct >= 80 ? '🥈' : pct >= 60 ? '🥉' : '❌';
    grandDone += done; grandTarget += target;
    lines.push(`${medal}  ${name}`, `    แปลได้:  ${done} ตอน`, `    เป้าหมาย: ${target} ตอน  (${workDays} วันทำงาน)`, `    ผลงาน:   ${pct.toFixed(1)}%`, '─'.repeat(32));
  }

  const grandPct = grandTarget ? (grandDone / grandTarget * 100) : 0;
  lines.push('', '╔══════════════════════════════╗', '║  🏆  รวมทั้งทีม                  ║',
    `║  แปลได้ทั้งสิ้น: ${grandDone} ตอน${''.padEnd(10)}║`, `║  เป้ารวม:       ${grandTarget} ตอน${''.padEnd(10)}║`,
    `║  ผลงานรวม:      ${grandPct.toFixed(1)}%${''.padEnd(13)}║`, '╚══════════════════════════════╝');

  const text = lines.join('\n');
  const gid  = _groupId();
  if (gid) {
    const tid = _topicId('topic_report');
    await _sendLong(bot, gid, text, tid ? { message_thread_id: tid } : {});
  }
  if (ADMIN_ID) await _sendLong(bot, ADMIN_ID, text, {});
}

// ── send_checkin_card (06:00) ─────────────────────────────────────────────────

async function sendCheckinCard(bot) {
  const gid    = _groupId();
  const tidVal = db.getConfig('topic_checkin');
  if (!gid || !tidVal) return;
  const now   = new Date();
  const today = h.bkkISODate(now);
  const wd    = h.bkkWeekday(now);
  const thaiDate = h.bkkThaiDate(now);
  const translators = db.getAllTranslatorSettings();
  const working = translators.filter(t => t.day_off !== wd);
  const onOff   = translators.filter(t => t.day_off === wd);
  const lines   = [`📋  เข้า-ออกงาน  ${thaiDate}\n`, 'กดปุ่มด้านล่างเพื่อบันทึกเวลาครับ\n'];
  if (working.length) {
    lines.push('รอเข้างาน:');
    for (const t of working) lines.push(`  ⬜  ${t.translator_name || String(t.user_id)}`);
  }
  if (onOff.length) {
    lines.push('\nวันหยุดวันนี้:');
    for (const t of onOff) lines.push(`  🏖️  ${t.translator_name || String(t.user_id)} (วัน${h.DAY_NAMES[t.day_off]})`);
  }
  const markup = { inline_keyboard: [[{ text: '🟢  เข้างาน', callback_data: 'grp_checkin' }, { text: '🔴  ออกงาน', callback_data: 'grp_checkout' }]] };
  const msg = await bot.telegram.sendMessage(gid, lines.join('\n'), { reply_markup: markup, message_thread_id: parseInt(tidVal, 10) });
  db.setConfig('checkin_card_msg_id', msg.message_id);
  db.setConfig('checkin_card_date', today);
}

// ── refresh_attendance_cards (every 30min) ────────────────────────────────────

async function refreshAttendanceCards(bot) {
  const now   = new Date();
  const today = h.bkkISODate(now);
  for (const t of db.getAllTranslatorSettings()) {
    const uid  = t.user_id;
    const name = t.translator_name || String(uid);
    const att  = db.getTodayAttendance(uid, today);
    if (!att || !att.check_in_at || att.check_out_at) continue;
    const msgId = db.getConfig(`att_card_msg_${uid}`);
    if (!msgId) continue;
    try {
      const { text, markup } = h.attendanceCard(uid, name);
      await bot.telegram.editMessageText(uid, parseInt(msgId, 10), null, text, { parse_mode: 'HTML', reply_markup: markup });
    } catch {}
  }
}

// ── setup ─────────────────────────────────────────────────────────────────────

function setup(bot) {
  cron.schedule('0 6 * * *',   () => sendCheckinCard(bot),    { timezone: TZ });
  cron.schedule('0 12 * * *',  () => sendReminder(bot),       { timezone: TZ });
  cron.schedule('0 22 * * *',  () => sendReminder(bot),       { timezone: TZ });
  cron.schedule('30 0 * * *',  () => sendDailySummary(bot),   { timezone: TZ });
  cron.schedule('0 1 * * *',   () => sendMonthlySummary(bot), { timezone: TZ });
  cron.schedule('*/30 * * * *', () => refreshAttendanceCards(bot), { timezone: TZ });
  console.log('Scheduler ready: checkin 06:00, report 12:00 & 22:00, summary 00:30, monthly 01:00, att refresh */30min (Asia/Bangkok)');
}

module.exports = { setup, sendReminder, sendDailySummary, sendMonthlySummary };
