'use strict';
const db = require('./db');

const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0', 10);
const MIN_HOURS = 8;
const DAY_NAMES = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
const BKK_OFFSET = 7 * 3600 * 1000;

let _bot = null;
function setup(bot) { _bot = bot; }

// ── Time helpers (Bangkok UTC+7) ──────────────────────────────────────────────

function _bkkNow() {
  return new Date(Date.now() + BKK_OFFSET);
}

function _bkkTimeStr(d = new Date()) {
  const bkk = new Date(d.getTime() + BKK_OFFSET);
  return `${String(bkk.getUTCHours()).padStart(2,'0')}:${String(bkk.getUTCMinutes()).padStart(2,'0')}`;
}

function _bkkISODate(d = new Date()) {
  return new Date(d.getTime() + BKK_OFFSET).toISOString().slice(0, 10);
}

function _bkkISOTS(d = new Date()) {
  return new Date(d.getTime() + BKK_OFFSET).toISOString().slice(0, 19);
}

function _bkkThaiDate(d = new Date()) {
  const bkk = new Date(d.getTime() + BKK_OFFSET);
  const day = String(bkk.getUTCDate()).padStart(2,'0');
  const mon = String(bkk.getUTCMonth() + 1).padStart(2,'0');
  const yr  = bkk.getUTCFullYear() + 543;
  return `${day}/${mon}/${yr}`;
}

function _bkkWeekday(d = new Date()) {
  const wd = new Date(d.getTime() + BKK_OFFSET).getUTCDay(); // 0=Sun
  return wd === 0 ? 6 : wd - 1; // Mon=0...Sun=6
}

// stored times are Bangkok ISO without 'Z'; treat as UTC+7 for arithmetic
function _displayTime(isoStr) {
  return isoStr ? isoStr.slice(11, 16) : '-';
}

function _hoursSince(storedIsoStr) {
  if (!storedIsoStr) return 0;
  const storedEpoch = new Date(storedIsoStr + 'Z').getTime();
  const nowBKKEpoch = Date.now() + BKK_OFFSET;
  return (nowBKKEpoch - storedEpoch) / 3600000;
}

// ── String helpers ────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _trunc(text, limit = 4000) {
  return text.length <= limit ? text : text.slice(0, limit - 20) + '\n…(ตัดออก)';
}

function _display(user) {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id);
}

function _groupId() {
  const v = db.getConfig('group_id');
  return v ? parseInt(v, 10) : 0;
}

function _topicId(key) {
  const v = db.getConfig(key);
  return v ? parseInt(v, 10) : null;
}

function _ikBtn(text, data) { return { text, callback_data: data }; }
function _ik(...rows) { return { inline_keyboard: rows }; }

// ── Caption/filename parsing ──────────────────────────────────────────────────

function _cleanName(fn) {
  if (!fn) return 'ไฟล์';
  let name = fn;
  while (name.toLowerCase().endsWith('.zip')) name = name.slice(0, -4);
  name = name.replace(/\.[a-zA-Z]{2,5}$/, '');
  return name || 'ไฟล์';
}

function _parseCaption(caption, filename) {
  const text = (caption || '').trim();
  if (text.includes('|')) {
    const [l, r] = text.split('|', 2);
    return [l.replace(/(?:\.zip)+$/i, '').trim() || 'ไฟล์', r.trim()];
  }
  if (text) return [text.replace(/(?:\.zip)+$/i, '').trim() || 'ไฟล์', ''];
  let name = _cleanName(filename).replace(/\s*\(\d+\)\s*$/, '').trim();
  const EP = '(\\d+(?:\\s*[-–]\\s*\\d+)?)';
  const pats = [
    new RegExp(`^(.+?)\\s+[-–]\\s+${EP}\\s*$`),
    new RegExp(`^(.+?)\\s+[-–]\\s+ch(?:apter)?\\.?\\s*${EP}\\s*$`, 'i'),
    new RegExp(`^(.+?)\\s+ตอน(?:ที่)?\\s*${EP}\\s*$`),
    new RegExp(`^(.+?)\\s+ep\\.?\\s*${EP}\\s*$`, 'i'),
    new RegExp(`^(.+?)\\s+ch(?:apter)?\\.?\\s*${EP}\\s*$`, 'i'),
    new RegExp(`^(.+?)\\s+(\\d+\\s*[-–]\\s*\\d+)\\s*$`),
  ];
  for (const p of pats) { const m = name.match(p); if (m) return [m[1].trim(), m[2].trim()]; }
  const n2 = name.replace(/_/g, ' ');
  for (const p of pats) { const m = n2.match(p); if (m) return [m[1].trim(), m[2].trim()]; }
  let m = name.match(/^(.+)_(\d+)_(\d+)$/);
  if (m) return [m[1].replace(/_/g,' ').trim(), `${m[2]}-${m[3]}`];
  m = name.match(/^(.+)[_\s](\d+)$/);
  if (m) return [m[1].replace(/_/g,' ').trim(), m[2]];
  return [name.replace(/_/g,' ').trim(), ''];
}

function _countFromChapterStr(s) {
  s = (s || '').trim();
  // "10 ตอน" / "10ตอน" — explicit count prefix
  let m = s.match(/^(\d+)\s*ตอน/);
  if (m) return Math.max(1, parseInt(m[1]));
  // Strip Thai/English chapter label prefixes before parsing range
  s = s.replace(/^(?:ตอนที่|ตอน|chapter|ch\.?|ep\.?)\s*/i, '').trim();
  // "1-12" / "1–12"
  m = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (m) return Math.max(1, parseInt(m[2]) - parseInt(m[1]) + 1);
  // "1 to 12"
  m = s.match(/^(\d+)\s+to\s+(\d+)$/i);
  if (m) return Math.max(1, parseInt(m[2]) - parseInt(m[1]) + 1);
  return 1;
}

// ── Job card rendering ────────────────────────────────────────────────────────

function _epStart(ep) {
  const m = (ep || '').trim().match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function _renderJobCard(job, claims) {
  const title   = job.manga_title || job.job_id;
  const chapter = job.episode || '';
  const total   = job.chapter_count || 1;
  const claimed = job.chapter_claimed || 0;
  const status  = job.status || 'pending';
  const epStart = _epStart(chapter);

  let section = '';
  if (claims && claims.length) {
    section = `🗂  <b>${total} ตอน</b>:\n`;
    for (const cl of claims) {
      const fr = cl.chapter_from, to = cl.chapter_to;
      let lbl;
      if (epStart !== null) {
        const a = epStart + fr - 1, b = epStart + to - 1;
        lbl = a !== b ? `ตอน ${a}–${b}` : `ตอน ${a}`;
      } else {
        lbl = fr !== to ? `ตอน ${fr}–${to}` : `ตอน ${fr}`;
      }
      section += `   ${cl.status === 'done' ? '✅' : '🔄'}  ${lbl}  →  ${_esc(cl.translator_name)}\n`;
    }
    const rem = total - claimed;
    if (rem > 0) {
      const nf = Math.max(...claims.map(c => c.chapter_to)) + 1;
      section += `   ⏳  ตอน ${nf}–${total}  →  <i>ยังว่าง</i>\n`;
    }
  } else if (total > 1) {
    section = `🗂  รวม <b>${total} ตอน</b>\n`;
  } else {
    section = chapter ? `📄  ตอนที่: <b>${chapter}</b>\n` : '';
  }

  let statusLine;
  if (status === 'pending') statusLine = '🆕  ว่าง — ยังไม่มีคนรับ';
  else if (status === 'partial') statusLine = `🔄  กำลังแปล ${claimed} ตอน  |  ⏳ ว่าง ${total - claimed} ตอน`;
  else if (status === 'in_progress') {
    const names = [...new Set((claims||[]).map(c => _esc(c.translator_name)))].join(', ');
    statusLine = `🔄  รับครบแล้ว  (${names})`;
  } else if (status === 'done') statusLine = '✅  เสร็จทั้งหมดแล้ว!';
  else statusLine = `สถานะ: ${status}`;

  const caption = `🎉  <b>งานแปลใหม่เข้ามาแล้ว!</b>\n\n📚  ชื่อเรื่อง: <b>${_esc(title)}</b>\n${section}▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n👤  ผู้ส่งงาน: ${job.sender_name || ''}\n${statusLine}`;

  let markup = null;
  const rem = total - claimed;
  if (rem > 0 && status !== 'done') {
    let btn;
    if (claims && claims.length) {
      const nfRel = Math.max(...claims.map(c => c.chapter_to)) + 1;
      if (epStart !== null) {
        btn = `✋  รับตอน ${epStart + nfRel - 1}–${epStart + total - 1}  (${rem} ตอน)`;
      } else {
        btn = `✋  รับตอน ${nfRel}–${total}  (${rem} ตอน)`;
      }
    } else {
      btn = total > 1 ? `✋  รับงานนี้  (${total} ตอน)` : '✋  รับงานนี้';
    }
    markup = _ik([_ikBtn(btn, `claim:${job.id}`)]);
  }
  return { caption, markup };
}

async function _updateJobCard(jobId) {
  const job = db.getJob(jobId);
  if (!job || !job.announcement_msg_id) return;
  const gid = _groupId();
  if (!gid) return;
  const { caption, markup } = _renderJobCard(job, db.getClaims(jobId));
  try {
    await _bot.telegram.editMessageCaption(gid, job.announcement_msg_id, null, caption,
      { parse_mode: 'HTML', reply_markup: markup });
  } catch {}
}

async function _postFileWithButton(jobId, jobPk, title, chapter, senderName, fileId, fileType, chapterList, chapterCount) {
  const gid = _groupId();
  if (!gid) return null;
  const eff = chapterList ? chapterList.length : chapterCount;
  let section = '';
  if (chapterList) {
    section = `🗂  <b>${eff} ตอน</b> ใน ZIP:\n`;
    chapterList.slice(0, 10).forEach(ch => { section += `   • ${ch}\n`; });
    if (eff > 10) section += `   <i>...และอีก ${eff - 10} ตอน</i>\n`;
  } else if (eff > 1) {
    section = `🗂  รวม <b>${eff} ตอน</b>\n`;
  } else {
    section = chapter ? `📄  ตอนที่: <b>${chapter}</b>\n` : '';
  }
  const caption = `🎉  <b>งานแปลใหม่เข้ามาแล้ว!</b>\n\n📚  ชื่อเรื่อง: <b>${_esc(title)}</b>\n${section}▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n👤  ผู้ส่งงาน: ${_esc(senderName)}\n🆕  ว่าง — ยังไม่มีคนรับ`;
  const markup = _ik([_ikBtn(eff > 1 ? `✋  รับงานนี้  (${eff} ตอน)` : '✋  รับงานนี้', `claim:${jobPk}`)]);
  const tid = _topicId('topic_jobs');
  const opts = { caption, parse_mode: 'HTML', reply_markup: markup, ...(tid ? { message_thread_id: tid } : {}) };
  try {
    return fileType === 'photo'
      ? await _bot.telegram.sendPhoto(gid, fileId, opts)
      : await _bot.telegram.sendDocument(gid, fileId, opts);
  } catch (e) {
    console.error(`postFileWithButton ${jobId}:`, e.message);
    if (ADMIN_ID) {
      try {
        await _bot.telegram.sendMessage(ADMIN_ID,
          `❌ โพสต์การ์ดงาน <b>${_esc(title)}</b> ไม่สำเร็จ\n<code>${_esc(e.message)}</code>\ngroup: <code>${gid}</code>  topic_jobs: <code>${tid}</code>`,
          { parse_mode: 'HTML' });
      } catch {}
    }
    return null;
  }
}

// ── Batch pending files ───────────────────────────────────────────────────────

const _pending = new Map();     // userId → { files, senderName, senderUserId, replyChatId, replyThreadId, flushTime }
const _pendingClaims = new Map(); // userId → claim data for confirm_partial

async function _flushPending(userId, flushTime) {
  const data = _pending.get(userId);
  if (!data || data.flushTime !== flushTime) return;
  _pending.delete(userId);
  const { files, senderName, senderUserId, replyChatId, replyThreadId } = data;

  const groups = new Map();
  for (const f of files) {
    const key = f.mediaGroupId || `${f.title}\x00${f.chapter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [key, gf] of groups) {
    if (typeof key === 'string' && !key.includes('\x00')) {
      const cap = gf.find(f => f.hasCaption);
      if (cap) gf.forEach(f => { f.title = cap.title; f.chapter = cap.chapter; });
    }
  }

  let jobCount = 0, lastTitle = '', lastChapter = '', lastCount = 1;
  for (const [, gf] of groups) {
    const first = gf[0];
    const { title, chapter } = first;
    const chapterCount = _countFromChapterStr(chapter);
    if (chapterCount > 12) {
      try {
        await _bot.telegram.sendMessage(replyChatId,
          `❌  <b>${_esc(title)}</b>  มี ${chapterCount} ตอน เกินกำหนดครับ\n\nกรุณาแบ่งส่งไม่เกิน <b>12 ตอน</b> ต่อครั้ง`,
          { parse_mode: 'HTML', ...(replyThreadId ? { message_thread_id: replyThreadId } : {}) });
      } catch {}
      continue;
    }
    const { jobId, pk } = db.createJob(first.fileId, first.fileName, first.fileType, title, chapter, senderUserId, senderName, chapterCount);
    const sent = await _postFileWithButton(jobId, pk, title, chapter, senderName, first.fileId, first.fileType, null, chapterCount);
    if (sent) {
      db.setAnnouncementMsgId(jobId, sent.message_id);
      const tid = _topicId('topic_jobs');
      for (let i = 1; i < gf.length; i++) {
        const f = gf[i];
        try {
          const extra = { caption: `📎  ไฟล์ ${i + 1}/${gf.length}`, reply_to_message_id: sent.message_id,
            ...(tid ? { message_thread_id: tid } : {}) };
          if (f.fileType === 'photo') await _bot.telegram.sendPhoto(_groupId(), f.fileId, extra);
          else await _bot.telegram.sendDocument(_groupId(), f.fileId, extra);
        } catch (e) { console.error('Extra file:', e.message); }
      }
    }
    lastTitle = title; lastChapter = chapter; lastCount = gf.length;
    jobCount++;
  }

  if (!jobCount) return;
  try {
    const confirm = jobCount > 1
      ? `✅  รับ <b>${jobCount} งาน</b> แล้วครับ ประกาศในห้องรับงานแปลเรียบร้อย`
      : `✅  สร้างงาน <b>${lastChapter ? `${lastTitle} | ${lastChapter}` : lastTitle}</b>${lastCount > 1 ? ` (${lastCount} ไฟล์)` : ''} แล้วครับ!`;
    await _bot.telegram.sendMessage(replyChatId, confirm,
      { parse_mode: 'HTML', ...(replyThreadId ? { message_thread_id: replyThreadId } : {}) });
  } catch {}
}

// ── Deliver done ──────────────────────────────────────────────────────────────

async function _deliverDone(user, jobId, claim) {
  const job = db.getJob(jobId);
  if (!job) return;
  const fileId    = claim.translated_file_id;
  const fileType  = claim.translated_type || 'document';
  const transName = claim.translator_name || _display(user);
  const title     = job.manga_title || jobId;
  const fr = claim.chapter_from, to = claim.chapter_to, cnt = claim.chapter_count;
  const rangeLbl  = cnt > 1 ? `ตอน ${fr}–${to}  (${cnt} ตอน)` : `ตอน ${fr}`;
  const cap = `✅  <b>งานแปลเสร็จแล้ว!</b>\n\n📚  ชื่อเรื่อง: <b>${_esc(title)}</b>\n📄  ${rangeLbl}\n▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n✏️  แปลโดย: ${_esc(transName)}\n👤  ส่งงานโดย: ${_esc(job.sender_name || '')}`;

  const gid = _groupId();
  const rtid = _topicId('topic_received');
  if (gid && rtid) {
    try {
      const kw = { caption: cap, parse_mode: 'HTML', message_thread_id: rtid };
      if (fileType === 'photo') await _bot.telegram.sendPhoto(gid, fileId, kw);
      else await _bot.telegram.sendDocument(gid, fileId, kw);
    } catch (e) {
      console.error('Deliver to received:', e.message);
      if (ADMIN_ID) {
        try { await _bot.telegram.sendMessage(ADMIN_ID, `❌ ส่งไฟล์ topic_received ไม่สำเร็จ\n<code>${_esc(e.message)}</code>`, { parse_mode: 'HTML' }); } catch {}
      }
    }
  }
  if (job.sender_user_id) {
    try {
      if (fileType === 'photo') await _bot.telegram.sendPhoto(job.sender_user_id, fileId, { caption: cap, parse_mode: 'HTML' });
      else await _bot.telegram.sendDocument(job.sender_user_id, fileId, { caption: cap, parse_mode: 'HTML' });
    } catch {}
  }
}

// ── Attendance card ───────────────────────────────────────────────────────────

function _attendanceCard(userId, name) {
  const now    = new Date();
  const today  = _bkkISODate(now);
  const tStr   = _bkkTimeStr(now);
  const tDate  = _bkkThaiDate(now);
  const att    = db.getTodayAttendance(userId, today);

  if (!att || !att.check_in_at) {
    return {
      text: `╔══════════════════════╗\n║   📋  บันทึกเวลาทำงาน   ║\n╚══════════════════════╝\n\n👤  <b>${_esc(name)}</b>\n📅  ${tDate}   🕐  ${tStr}\n\n⬜  ยังไม่ได้เข้างานวันนี้\n\nกด <b>เข้างาน</b> เพื่อเริ่มนับเวลาครับ`,
      markup: _ik([_ikBtn('🟢  เข้างาน', 'checkin')]),
    };
  }
  if (!att.check_out_at) {
    const elapsed = _hoursSince(att.check_in_at);
    const barLen  = Math.min(Math.floor(elapsed / MIN_HOURS * 10), 10);
    const bar     = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
    return {
      text: `╔══════════════════════╗\n║   📋  บันทึกเวลาทำงาน   ║\n╚══════════════════════╝\n\n👤  <b>${_esc(name)}</b>\n📅  ${tDate}\n\n🟢  เข้างาน:  <b>${_displayTime(att.check_in_at)}</b>\n⏱  ผ่านมา:   <b>${elapsed.toFixed(1)} ชม.</b>\n\n[${bar}]  ${elapsed.toFixed(1)}/${MIN_HOURS} ชม.`,
      markup: _ik([_ikBtn('🔴  ออกงาน', 'checkout')]),
    };
  }
  const hours  = att.hours_worked || 0;
  const status = hours >= MIN_HOURS ? '✅  ครบ 8 ชม. แล้ว' : `⚠️  ยังไม่ครบ 8 ชม. (${hours.toFixed(1)} ชม.)`;
  return {
    text: `╔══════════════════════╗\n║   📋  บันทึกเวลาทำงาน   ║\n╚══════════════════════╝\n\n👤  <b>${_esc(name)}</b>\n📅  ${tDate}\n\n🟢  เข้างาน:  <b>${_displayTime(att.check_in_at)}</b>\n🔴  ออกงาน:  <b>${_displayTime(att.check_out_at)}</b>\n⏱  รวม:      <b>${hours.toFixed(1)} ชม.</b>\n\n${status}`,
    markup: _ik([_ikBtn('🔄  เข้างานใหม่', 'checkin')]),
  };
}

// ── Dayoff helpers ────────────────────────────────────────────────────────────

function _dayoffKeyboard() {
  return { inline_keyboard: [
    [0,1,2].map(i => _ikBtn(DAY_NAMES[i], `dayoff:${i}`)),
    [3,4,5].map(i => _ikBtn(DAY_NAMES[i], `dayoff:${i}`)),
    [_ikBtn(DAY_NAMES[6], 'dayoff:6')],
  ]};
}

function _renderDayoffGroupCard() {
  const lines = [
    '╔══════════════════════════╗',
    '║  📅  วันหยุดประจำสัปดาห์  ║',
    '╚══════════════════════════╝\n',
    'กดปุ่มด้านล่างเพื่อเลือกวันหยุดของคุณได้เลยครับ\n',
  ];
  const translators = db.getAllTranslatorSettings();
  if (translators.length) {
    lines.push('สถานะปัจจุบัน:');
    for (const t of translators) {
      lines.push(`  ✅  ${t.translator_name || String(t.user_id)}  →  วัน${DAY_NAMES[t.day_off]}`);
    }
  } else {
    lines.push('(ยังไม่มีนักแปลเลือกวันหยุด)');
  }
  return lines.join('\n');
}

// ── Submit buttons ────────────────────────────────────────────────────────────

function _submitButtonsKb(claims) {
  return claims.map(cl => {
    const title = cl.manga_title || cl.job_id;
    const { chapter_from: fr, chapter_to: to, chapter_count: cnt } = cl;
    const label = cnt > 1 ? `📖  ${title}  |  ตอน ${fr}–${to}  (${cnt} ตอน)` : `📖  ${title}  |  ตอน ${fr}`;
    return [_ikBtn(label, `submit_claim:${cl.id}`)];
  });
}

async function _showSubmitButtons(ctx, claims) {
  if (!claims.length) { await ctx.reply('ไม่มีงานที่รับไว้ครับ'); return; }
  await ctx.reply('📋  เลือกงานที่แปลเสร็จแล้วครับ:', { reply_markup: { inline_keyboard: _submitButtonsKb(claims) } });
}

async function _dmSubmitButtons(userId, claims, fileId, fileType) {
  db.setState(userId, { pending_file_id: fileId, file_type: fileType });
  try {
    await _bot.telegram.sendMessage(userId,
      '📋  ชื่อไฟล์ไม่ตรงกับงานในระบบ\n<b>กรุณาเลือกว่าไฟล์นี้เป็นงานชิ้นไหนครับ:</b>',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: _submitButtonsKb(claims) } });
  } catch (e) { console.warn(`DM submit buttons to ${userId}:`, e.message); }
}

// ── /start ────────────────────────────────────────────────────────────────────

async function startCommand(ctx) {
  const user = ctx.from;
  const chat = ctx.chat;
  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (user.id === ADMIN_ID) {
      await ctx.reply(
        `Group ID: <code>${chat.id}</code>\nThread ID: <code>${ctx.message.message_thread_id || '-'}</code>`,
        { parse_mode: 'HTML' });
    }
    return;
  }
  try {
    const name    = _display(user);
    const current = db.getTranslatorDayoff(user.id);
    const { text, markup } = _attendanceCard(user.id, name);
    const existingId = db.getConfig(`att_card_msg_${user.id}`);
    if (existingId) {
      try {
        await _bot.telegram.editMessageText(user.id, parseInt(existingId, 10), null, text,
          { parse_mode: 'HTML', reply_markup: markup });
      } catch {
        const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
        db.setConfig(`att_card_msg_${user.id}`, sent.message_id);
      }
    } else {
      const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup });
      db.setConfig(`att_card_msg_${user.id}`, sent.message_id);
    }
    if (current === null) {
      await ctx.reply('📅  <b>กรุณาเลือกวันหยุดประจำสัปดาห์ของคุณ</b>',
        { parse_mode: 'HTML', reply_markup: _dayoffKeyboard() });
    } else {
      await ctx.reply(`📅  วันหยุดของคุณ: <b>วัน${DAY_NAMES[current]}</b>  (กด /dayoff เพื่อเปลี่ยน)`,
        { parse_mode: 'HTML' });
    }
  } catch (e) {
    console.error('startCommand:', e);
    try { await ctx.reply(`❌ เกิดข้อผิดพลาด: ${e.message}`); } catch {}
  }
}

// ── /settopic & /setgroup ─────────────────────────────────────────────────────

async function settopicCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const chat = ctx.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') { await ctx.reply('รันในกลุ่มครับ'); return; }
  const threadId = ctx.message.message_thread_id;
  const labels = {
    send:     ['topic_send',     'ห้องส่งงานแปล'],
    jobs:     ['topic_jobs',     'ห้องรับงานแปล'],
    complete: ['topic_complete', 'ห้องงานเสร็จแล้ว (นักแปลส่ง)'],
    received: ['topic_received', 'ห้องรับงานที่เสร็จแล้ว (admin รับ)'],
    report:   ['topic_report',   'รายงานผลการทำงาน'],
    checkin:  ['topic_checkin',  'ห้องเข้า-ออกงาน'],
    dayoff:   ['topic_dayoff',   'ห้องวันหยุดประจำสัปดาห์'],
  };
  const help = 'ระบุประเภทด้วยครับ:\n<code>/settopic send|jobs|complete|received|report|checkin|dayoff</code>';
  if (!threadId) { await ctx.reply(help, { parse_mode: 'HTML' }); return; }
  const type = (ctx.args?.[0] || '').toLowerCase();
  if (!labels[type]) { await ctx.reply(help, { parse_mode: 'HTML' }); return; }
  db.setConfig('group_id', chat.id);
  db.setConfig(labels[type][0], threadId);
  await ctx.reply(`✅ ตั้ง ${labels[type][1]} แล้วครับ!`);
}

async function setgroupCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
  db.setConfig('group_id', ctx.chat.id);
  await ctx.reply('✅ บันทึกกลุ่มแล้วครับ!');
}

// ── /dayoff ───────────────────────────────────────────────────────────────────

async function dayoffCommand(ctx) {
  const current = db.getTranslatorDayoff(ctx.from.id);
  const cur = current !== null ? `\n\n(ตอนนี้: วัน${DAY_NAMES[current]})` : '';
  await ctx.reply(`เลือกวันหยุดประจำสัปดาห์ของคุณครับ${cur}`, { reply_markup: _dayoffKeyboard() });
}

// ── /board ────────────────────────────────────────────────────────────────────

async function boardCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
  const tid = ctx.message.message_thread_id;
  const sendTid = _topicId('topic_send');
  const completeTid = _topicId('topic_complete');
  if (sendTid && tid === sendTid) {
    await ctx.reply('┌─────────────────────\n│  📤  <b>ห้องส่งงานแปล</b>\n└─────────────────────\n\nโพสต์ไฟล์พร้อม caption:\n<code>ชื่อเรื่อง | ตอนที่</code>',
      { parse_mode: 'HTML', reply_markup: _ik([_ikBtn('📤  ส่งงานใหม่', 'new_job')]) });
  } else if (completeTid && tid === completeTid) {
    await ctx.reply('┌─────────────────────\n│  ✅  <b>งานเสร็จแล้ว</b>\n└─────────────────────\n\nกดปุ่มด้านล่าง หรือโพสต์ไฟล์ในห้องนี้',
      { parse_mode: 'HTML', reply_markup: _ik([_ikBtn('✅  ส่งงานแปลเสร็จ', 'select_done')]) });
  } else {
    await ctx.reply('ต้องรันใน topic ที่ตั้งค่าไว้แล้วครับ');
  }
}

// ── /postcheckin & /postdayoff ────────────────────────────────────────────────

async function postcheckinCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const gid = _groupId();
  if (!gid) { await ctx.reply('❌ ยังไม่ได้ตั้งกลุ่มครับ'); return; }
  const tidVal = db.getConfig('topic_checkin');
  if (!tidVal) { await ctx.reply('❌ ยังไม่ได้ตั้งห้องเข้า-ออกงานครับ'); return; }
  const now = new Date();
  const today = _bkkISODate(now);
  const dateStr = _bkkThaiDate(now);
  const translators = db.getAllTranslatorSettings();
  const attRecords  = db.getAllTodayAttendance(today);
  const attByUid    = Object.fromEntries(attRecords.map(r => [r.user_id, r]));
  const lines = [`📋  เข้า-ออกงาน  ${dateStr}\n`, 'กดปุ่มด้านล่างเพื่อบันทึกเวลาครับ\n'];
  const wd = _bkkWeekday(now);
  for (const t of translators) {
    const uid = t.user_id, tname = t.translator_name || String(uid);
    if (wd === t.day_off) { lines.push(`  🏖️  ${tname}  (วันหยุด${DAY_NAMES[t.day_off]})`); continue; }
    const att = attByUid[uid];
    if (!att || !att.check_in_at) lines.push(`  ⬜  ${tname}`);
    else if (!att.check_out_at) lines.push(`  🟢  ${tname}  เข้า ${_displayTime(att.check_in_at)}`);
    else {
      const h = att.hours_worked || 0;
      lines.push(`  ${h >= MIN_HOURS ? '✅' : '⚠️'}  ${tname}  ${_displayTime(att.check_in_at)}–${_displayTime(att.check_out_at)}  (${h.toFixed(1)} ชม.)`);
    }
  }
  const markup = _ik([_ikBtn('🟢  เข้างาน', 'grp_checkin'), _ikBtn('🔴  ออกงาน', 'grp_checkout')]);
  const msg = await _bot.telegram.sendMessage(gid, lines.join('\n'), { reply_markup: markup, message_thread_id: parseInt(tidVal, 10) });
  db.setConfig('checkin_card_msg_id', msg.message_id);
  db.setConfig('checkin_card_date', today);
  await ctx.reply('✅ โพสต์การ์ดเข้า-ออกงานแล้วครับ!');
}

async function postdayoffCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const gid = _groupId();
  if (!gid) { await ctx.reply('❌ ยังไม่ได้ตั้งกลุ่มครับ'); return; }
  const tidVal = db.getConfig('topic_dayoff');
  if (!tidVal) { await ctx.reply('❌ ยังไม่ได้ตั้งห้องวันหยุดครับ'); return; }
  const msg = await _bot.telegram.sendMessage(gid, _renderDayoffGroupCard(),
    { reply_markup: _dayoffKeyboard(), message_thread_id: parseInt(tidVal, 10) });
  db.setConfig('dayoff_card_msg_id', msg.message_id);
  await ctx.reply('✅ โพสต์การ์ดวันหยุดในห้องแล้วครับ!');
}

// ── /alljobs ──────────────────────────────────────────────────────────────────

async function alljobsCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const jobs = db.getAllJobsSummary();
  if (!jobs.length) { await ctx.reply('ยังไม่มีงาน'); return; }
  const icons = { pending: '⏳', partial: '🔀', in_progress: '🔄', done: '✅' };
  let text = '📊 <b>งาน 50 รายการล่าสุด:</b>\n\n';
  for (const j of jobs) {
    const title = j.manga_title || j.job_id;
    const lbl   = j.episode ? `${title} | ${j.episode}` : title;
    const cnt   = j.chapter_count || 1;
    text += `${icons[j.status] || '?'}  <b>${lbl}</b>${cnt > 1 ? `  <i>(${cnt} ตอน)</i>` : ''}\n`;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
}

// ── /teamstats ────────────────────────────────────────────────────────────────

async function teamstatsCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const now = new Date();
  const today = _bkkISODate(now);
  const bkk = new Date(now.getTime() + BKK_OFFSET);
  const yr = bkk.getUTCFullYear(), mo = bkk.getUTCMonth() + 1;
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const translators = db.getAllTranslatorSettings();
  if (!translators.length) { await ctx.reply('ยังไม่มีนักแปลในระบบครับ'); return; }
  const lines = [`📊  <b>สรุปยอดแปล ${monthNames[mo-1]} ${yr+543}</b>\n`, `📅  ${_bkkThaiDate(now)}  ${_bkkTimeStr(now)} น.\n`];
  let grand = 0;
  for (const t of translators) {
    const uid = t.user_id, name = t.translator_name || String(uid);
    const todayCh = db.getCompletedChaptersOnDate(uid, today);
    const monthCh = db.getCompletedChaptersInMonth(uid, yr, mo);
    grand += monthCh;
    lines.push(`• <b>${_esc(name)}</b>\n  วันนี้: ${todayCh} ตอน  |  เดือนนี้: ${monthCh} ตอน`);
  }
  lines.push('', `🏆  <b>รวมทั้งทีมเดือนนี้: ${grand} ตอน</b>`);
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// ── /users ────────────────────────────────────────────────────────────────────

async function usersCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const translators = db.getAllTranslatorSettings();
  if (!translators.length) { await ctx.reply('ยังไม่มีนักแปลในระบบครับ'); return; }
  const lines = ['👥  <b>นักแปลในระบบ:</b>\n'];
  for (const t of translators) {
    const name  = t.translator_name || '(ไม่มีชื่อ)';
    const count = db.getUserInprogressChapterCount(t.user_id);
    const done  = db.getUserDoneClaims(t.user_id).length;
    const status = count ? `🔄 ${count} ตอน` : (done ? '⚠️ done ค้าง' : '✅ ว่าง');
    lines.push(`• <b>${_esc(name)}</b>\n  ID: <code>${t.user_id}</code>  |  ${status}`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// ── /resetclaim ───────────────────────────────────────────────────────────────

async function resetclaimCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.args || [];
  if (!args.length) {
    await ctx.reply('ใช้งาน: <code>/resetclaim &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const targetId = parseInt(args[0], 10);
  if (isNaN(targetId)) { await ctx.reply('user_id ต้องเป็นตัวเลขครับ'); return; }
  const count = db.resetDoneClaims(targetId);
  if (count) await ctx.reply(`✅ เปิด ${count} claim กลับเป็น in_progress แล้วครับ`);
  else await ctx.reply('ไม่พบ done claim ของ user นี้ครับ');
}

// ── /addchapters ──────────────────────────────────────────────────────────────

async function addchaptersCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.args || [];
  if (args.length < 2) {
    await ctx.reply('ใช้งาน:\n<code>/addchapters &lt;user_id&gt; &lt;จำนวนตอน&gt; [YYYY-MM-DD]</code>', { parse_mode: 'HTML' });
    return;
  }
  const targetId = parseInt(args[0], 10), chapCount = parseInt(args[1], 10);
  if (isNaN(targetId) || isNaN(chapCount)) { await ctx.reply('user_id และจำนวนตอนต้องเป็นตัวเลขครับ'); return; }
  if (chapCount < 1) { await ctx.reply('จำนวนตอนต้องมากกว่า 0 ครับ'); return; }
  let dateStr = args[2] || _bkkISODate();
  if (args[2] && !/^\d{4}-\d{2}-\d{2}$/.test(args[2])) { await ctx.reply('รูปแบบวันที่ต้องเป็น YYYY-MM-DD ครับ'); return; }
  const trans = db.getAllTranslatorSettings().find(t => t.user_id === targetId);
  if (!trans) { await ctx.reply('ไม่พบนักแปลคนนี้ในระบบครับ ดูรายชื่อด้วย /users'); return; }
  const now = new Date();
  const bkk = new Date(now.getTime() + BKK_OFFSET);
  db.addManualChapters(targetId, trans.translator_name || String(targetId), chapCount, dateStr);
  const monthTotal = db.getCompletedChaptersInMonth(targetId, bkk.getUTCFullYear(), bkk.getUTCMonth() + 1);
  await ctx.reply(
    `✅  บันทึกแล้วครับ!\n\n👤  ${_esc(trans.translator_name || String(targetId))}\n📅  ${dateStr}  +${chapCount} ตอน\n📊  รวมเดือนนี้: ${monthTotal} ตอน`,
    { parse_mode: 'HTML' });
}

// ── /topics & /dbinfo & /testnotify ──────────────────────────────────────────

async function topicsCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = ['group_id','topic_send','topic_jobs','topic_complete','topic_report','topic_checkin','topic_dayoff','topic_received'];
  const lines = ['📋 <b>Config ปัจจุบัน:</b>\n'];
  for (const k of keys) {
    lines.push(`<code>${k}</code>: ${db.getConfig(k) || '❌ ยังไม่ได้ตั้ง'}`);
  }
  if (ctx.message.message_thread_id)
    lines.push(`\n<b>ห้องนี้ thread_id:</b> <code>${ctx.message.message_thread_id}</code>`);
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function dbinfoCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const fs = require('fs');
  const { DB_PATH } = require('./db');
  const exists = fs.existsSync(DB_PATH);
  const size   = exists ? fs.statSync(DB_PATH).size : 0;
  const lines = [
    '🗄  <b>DB Info</b>',
    `path: <code>${DB_PATH}</code>`,
    `exists: ${exists ? '✅' : '❌'}`,
    `size: ${size.toLocaleString()} bytes`,
    `jobs: ${db.getAllJobsSummary().length} รายการ`,
    `translators: ${db.getAllTranslatorSettings().length} คน`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function testNotifyCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const scheduler = require('./scheduler');
  await scheduler.sendReminder(_bot);
  await scheduler.sendDailySummary(_bot);
  await ctx.reply('✅ ส่งแจ้งเตือนทดสอบแล้ว');
}

// ── /fixclaims ────────────────────────────────────────────────────────────────

async function fixclaimsCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const claims = db.getAllActiveClaims();
  if (!claims.length) { await ctx.reply('✅ ไม่มี claim ค้างอยู่เลยครับ'); return; }
  const byT = {};
  for (const cl of claims) {
    const k = cl.translator_name || String(cl.translator_id);
    if (!byT[k]) byT[k] = [];
    byT[k].push(cl);
  }
  const lines = [`⚠️  จะ mark <b>${claims.length} claim</b> เป็นเสร็จแล้ว:\n`];
  for (const [name, clms] of Object.entries(byT)) {
    lines.push(`  • ${_esc(name)}: ${clms.reduce((s,c) => s + c.chapter_count, 0)} ตอน  (${clms.length} claim)`);
  }
  lines.push('', 'กด ✅ ยืนยัน เพื่อดำเนินการ');
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: _ik([_ikBtn('✅ ยืนยัน fix', 'fixclaims:confirm'), _ikBtn('❌ ยกเลิก', 'fixclaims:cancel')]),
  });
}

// ── /admin panel ──────────────────────────────────────────────────────────────

async function adminCommand(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply('🎛  <b>Admin Panel</b>\n\nเลือกหมวดที่ต้องการดูครับ:', {
    parse_mode: 'HTML',
    reply_markup: _ik(
      [_ikBtn('📊 ยอดแปล', 'adm:stats'), _ikBtn('👥 นักแปล', 'adm:translators')],
      [_ikBtn('📋 งานค้าง', 'adm:jobs'), _ikBtn('🕐 เข้างาน', 'adm:attendance')],
      [_ikBtn('⚠️ Errors', 'adm:errors'), _ikBtn('🔧 ระบบ', 'adm:system')],
      [_ikBtn('📋 Debug dump', 'adm:dump')],
    ),
  });
}

// ── Message: group file handler ───────────────────────────────────────────────

async function handleGroupFile(ctx) {
  const msg     = ctx.message;
  const user    = ctx.from;
  const threadId = msg.message_thread_id;
  const sendTid     = _topicId('topic_send');
  const jobsTid     = _topicId('topic_jobs');
  const completeTid = _topicId('topic_complete');

  // ── ห้องส่งงาน: batch + flush ───────────────────────────────────────────────
  if (sendTid && threadId === sendTid) {
    let fileId, fileName, fileType, fileSize;
    if (msg.document) {
      fileId = msg.document.file_id; fileName = msg.document.file_name || 'ไฟล์';
      fileType = 'document'; fileSize = msg.document.file_size || 0;
    } else if (msg.photo) {
      const ph = msg.photo[msg.photo.length - 1];
      fileId = ph.file_id; fileName = `photo_${ph.file_unique_id}.jpg`;
      fileType = 'photo'; fileSize = ph.file_size || 0;
    } else return;

    const caption = (msg.caption || '').trim();
    const [title, chapter] = _parseCaption(caption, fileName);
    const senderName    = _display(user);
    const mediaGroupId  = msg.media_group_id || null;
    const now           = Date.now();

    if (!_pending.has(user.id)) {
      _pending.set(user.id, {
        files: [], senderName, senderUserId: user.id,
        replyChatId: msg.chat.id, replyThreadId: threadId, flushTime: now,
      });
    }
    const data = _pending.get(user.id);
    data.flushTime = now;
    data.files.push({ fileId, fileName, fileSize, fileType, title, chapter, hasCaption: !!caption, mediaGroupId });
    setTimeout(() => _flushPending(user.id, now), 3000);
  }

  // ── ห้องรับงาน: reply ไฟล์แปลเสร็จ ────────────────────────────────────────
  else if (jobsTid && threadId === jobsTid) {
    if (!msg.reply_to_message || (!msg.document && !msg.photo)) return;
    const job = db.getJobByAnnouncementMsgId(msg.reply_to_message.message_id);
    if (!job) return;
    const claim = db.getClaimByTranslator(job.job_id, user.id);
    if (!claim) { await ctx.reply('⚠️ คุณยังไม่ได้รับงานนี้ครับ'); return; }
    const fileId   = msg.document ? msg.document.file_id : msg.photo[msg.photo.length-1].file_id;
    const fileType = msg.document ? 'document' : 'photo';
    const { ok, err, job: updatedJob } = db.completeClaim(claim.id, user.id, fileId, fileType);
    if (!ok) { await ctx.reply(`⚠️ ${err}`); return; }
    const title = job.manga_title || job.job_id;
    const { chapter_from: fr, chapter_to: to, chapter_count: cnt } = claim;
    await ctx.reply(
      `✅  ส่งงาน <b>${title}  —  ${cnt > 1 ? `ตอน ${fr}–${to}  (${cnt} ตอน)` : `ตอน ${fr}`}</b> เรียบร้อยแล้วครับ!`,
      { parse_mode: 'HTML' });
    claim.translated_file_id = fileId; claim.translated_type = fileType;
    await _deliverDone(user, job.job_id, claim);
    await _updateJobCard(job.job_id);
  }

  // ── ห้องงานเสร็จ: ส่งไฟล์แปลเสร็จ ────────────────────────────────────────
  else if (completeTid && threadId === completeTid) {
    let fileId, fileType, fname;
    if (msg.document) { fileId = msg.document.file_id; fileType = 'document'; fname = msg.document.file_name || ''; }
    else if (msg.photo) { const ph = msg.photo[msg.photo.length-1]; fileId = ph.file_id; fileType = 'photo'; fname = ''; }
    else return;

    const transName = _display(user);
    const claims    = db.getUserActiveClaims(user.id);

    function _mscore(title, fn) {
      const t = (title||'').toLowerCase().replace(/[^\w\s]/g,'');
      const f = (fn||'').toLowerCase().replace(/\.zip$/i,'').replace(/[^\w\s]/g,'');
      const words = t.split(/\s+/).filter(w => w.length > 2);
      if (!words.length) return 0;
      return Math.floor(words.filter(w => f.includes(w)).length * 100 / words.length);
    }

    const seenJobs = {};
    for (const cl of claims) if (!seenJobs[cl.job_id]) seenJobs[cl.job_id] = cl;

    const state = db.getState(user.id);
    const preClaimId = state.action === 'send_done' ? state.claim_id : null;
    let bestClaim = preClaimId ? claims.find(c => c.id === preClaimId) || null : null;

    if (!bestClaim && Object.keys(seenJobs).length) {
      const uniq = Object.values(seenJobs);
      if (uniq.length === 1) {
        bestClaim = uniq[0];
      } else {
        const bestScore = Math.max(...uniq.map(cl => _mscore(cl.manga_title, fname)));
        if (bestScore >= 40) bestClaim = uniq.find(cl => _mscore(cl.manga_title, fname) === bestScore) || null;
      }
    }

    if (bestClaim) {
      db.clearState(user.id);
      const { ok, err, job: updJob } = db.completeClaim(bestClaim.id, user.id, fileId, fileType);
      if (ok && updJob) {
        bestClaim.translated_file_id = fileId; bestClaim.translated_type = fileType;
        await _deliverDone(user, updJob.job_id, bestClaim);
        await _updateJobCard(updJob.job_id);
      } else {
        const gid = _groupId(), rtid = _topicId('topic_received');
        if (gid && rtid) {
          try {
            const cap = `📁  <b>${_esc(transName)}</b>  (⚠️ ${_esc(err)})`;
            const kw = { caption: cap, parse_mode: 'HTML', message_thread_id: rtid };
            if (fileType === 'photo') await _bot.telegram.sendPhoto(gid, fileId, kw);
            else await _bot.telegram.sendDocument(gid, fileId, kw);
          } catch {}
        }
      }
      try { await ctx.deleteMessage(); } catch {}
    } else if (Object.keys(seenJobs).length) {
      await _dmSubmitButtons(user.id, Object.values(seenJobs), fileId, fileType);
      try {
        await _bot.telegram.sendMessage(msg.chat.id, `📩  <b>${_esc(transName)}</b> — บอทส่ง DM ให้เลือกงานแล้วครับ`,
          { parse_mode: 'HTML', message_thread_id: threadId });
      } catch {}
      try { await ctx.deleteMessage(); } catch {}
    } else {
      const gid = _groupId(), rtid = _topicId('topic_received');
      if (gid && rtid) {
        try {
          const kw = { caption: `📁  <b>${_esc(transName)}</b>`, parse_mode: 'HTML', message_thread_id: rtid };
          if (fileType === 'photo') await _bot.telegram.sendPhoto(gid, fileId, kw);
          else await _bot.telegram.sendDocument(gid, fileId, kw);
          try { await ctx.deleteMessage(); } catch {}
        } catch { await ctx.reply('✅  ส่งไฟล์ไปห้องรับงานแล้วครับ!'); }
      }
    }
  }
}

// ── DM file handlers ──────────────────────────────────────────────────────────

async function handleDocument(ctx) {
  if (ctx.chat.type !== 'private') return;
  const claims = db.getUserActiveClaims(ctx.from.id);
  if (claims.length) {
    db.setState(ctx.from.id, { pending_file_id: ctx.message.document.file_id, file_type: 'document' });
    await _showSubmitButtons(ctx, claims);
  } else {
    await ctx.reply('📋 ส่งไฟล์ได้ที่ห้องส่งงานแปลในกลุ่มครับ\nแนบ caption: <code>ชื่อเรื่อง | ตอน</code>', { parse_mode: 'HTML' });
  }
}

async function handlePhoto(ctx) {
  if (ctx.chat.type !== 'private') return;
  const claims = db.getUserActiveClaims(ctx.from.id);
  if (claims.length) {
    db.setState(ctx.from.id, { pending_file_id: ctx.message.photo[ctx.message.photo.length-1].file_id, file_type: 'photo' });
    await _showSubmitButtons(ctx, claims);
  } else {
    await ctx.reply('📋 ส่งไฟล์ได้ที่ห้องส่งงานแปลในกลุ่มครับ');
  }
}

async function handleText(ctx) {
  if (ctx.chat.type !== 'private') return;
  await ctx.reply('ส่งไฟล์ในกลุ่มได้เลยครับ 📂');
}

// ── Callback query handler ────────────────────────────────────────────────────

async function callbackHandler(ctx) {
  const query = ctx.callbackQuery;
  const user  = query.from;
  const data  = query.data;

  // ── ADMIN callbacks ──────────────────────────────────────────────────────────
  if (data.startsWith('adm:')) {
    if (user.id !== ADMIN_ID) { await ctx.answerCbQuery('ไม่มีสิทธิ์ครับ', { show_alert: true }); return; }
    const action = data.split(':', 2)[1];
    await ctx.answerCbQuery();
    const now = new Date();
    const today = _bkkISODate(now);
    const bkk = new Date(now.getTime() + BKK_OFFSET);
    const yr = bkk.getUTCFullYear(), mo = bkk.getUTCMonth() + 1;
    const thaiYr = yr + 543;
    const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const backKb = _ik([_ikBtn('◀️ กลับ', 'adm:main')]);
    let text = '';

    if (action === 'main') {
      try {
        await ctx.editMessageText('🎛  <b>Admin Panel</b>\n\nเลือกหมวดที่ต้องการดูครับ:', {
          parse_mode: 'HTML',
          reply_markup: _ik(
            [_ikBtn('📊 ยอดแปล', 'adm:stats'), _ikBtn('👥 นักแปล', 'adm:translators')],
            [_ikBtn('📋 งานค้าง', 'adm:jobs'), _ikBtn('🕐 เข้างาน', 'adm:attendance')],
            [_ikBtn('⚠️ Errors', 'adm:errors'), _ikBtn('🔧 ระบบ', 'adm:system')],
            [_ikBtn('📋 Debug dump', 'adm:dump')],
          ),
        });
      } catch {}
      return;
    } else if (action === 'stats') {
      const translators = db.getAllTranslatorSettings();
      const lines = [`📊  <b>ยอดแปล ${monthNames[mo-1]} ${thaiYr}</b>\n`];
      let grand = 0;
      for (const t of translators) {
        const todayCh = db.getCompletedChaptersOnDate(t.user_id, today);
        const monthCh = db.getCompletedChaptersInMonth(t.user_id, yr, mo);
        grand += monthCh;
        const icon = todayCh >= 12 ? '✅' : (todayCh > 0 ? '⚠️' : '❌');
        lines.push(`${icon}  <b>${_esc(t.translator_name || String(t.user_id))}</b>\n   วันนี้ ${todayCh} ตอน  |  เดือนนี้ ${monthCh} ตอน`);
      }
      lines.push('', `🏆  รวมทีมเดือนนี้: <b>${grand} ตอน</b>`);
      text = lines.join('\n');
    } else if (action === 'translators') {
      const translators = db.getAllTranslatorSettings();
      const lines = ['👥  <b>นักแปลในระบบ</b>\n'];
      for (const t of translators) {
        const inprog = db.getUserInprogressChapterCount(t.user_id);
        lines.push(`• <b>${_esc(t.translator_name || String(t.user_id))}</b>  (ID: <code>${t.user_id}</code>)\n  หยุด${DAY_NAMES[t.day_off]}  |  ${inprog ? `🔄 ${inprog} ตอนค้าง` : '✅ ว่าง'}`);
      }
      text = translators.length ? lines.join('\n') : 'ยังไม่มีนักแปลในระบบ';
    } else if (action === 'jobs') {
      const claims = db.getAllActiveClaims();
      const pendingJobs = db.getAllJobsSummary().filter(j => ['pending','partial'].includes(j.status));
      const lines = ['📋  <b>สถานะงานตอนนี้</b>\n'];
      if (claims.length) {
        const byT = {};
        for (const cl of claims) { if (!byT[cl.translator_id]) byT[cl.translator_id] = []; byT[cl.translator_id].push(cl); }
        lines.push('🔄  <b>กำลังแปลอยู่:</b>');
        for (const [uid, uclms] of Object.entries(byT)) {
          for (const cl of uclms) {
            const rng = cl.chapter_count > 1 ? `ตอน ${cl.chapter_from}–${cl.chapter_to}` : `ตอน ${cl.chapter_from}`;
            lines.push(`  • ${_esc(cl.translator_name || String(uid))}  →  ${_esc(cl.manga_title || cl.job_id)}  ${rng}`);
          }
        }
      } else lines.push('✨  ไม่มีงานค้างอยู่');
      if (pendingJobs.length) {
        lines.push(`\n⏳  <b>รอคนรับ ${pendingJobs.length} งาน:</b>`);
        for (const j of pendingJobs.slice(0, 10)) {
          const rem = (j.chapter_count||1) - (j.chapter_claimed||0);
          lines.push(`  • ${_esc(j.manga_title || j.job_id)}  (${rem} ตอนว่าง)`);
        }
      }
      text = lines.join('\n');
    } else if (action === 'attendance') {
      const translators = db.getAllTranslatorSettings();
      const attByUid = Object.fromEntries(db.getAllTodayAttendance(today).map(r => [r.user_id, r]));
      const wd = _bkkWeekday(now);
      const lines = [`🕐  <b>สถานะเข้างาน ${_bkkThaiDate(now)}</b>\n`];
      for (const t of translators) {
        const uid = t.user_id, name = _esc(t.translator_name || String(uid));
        if (wd === t.day_off) { lines.push(`🏖️  ${name}  (วันหยุด${DAY_NAMES[t.day_off]})`); continue; }
        const att = attByUid[uid];
        if (!att || !att.check_in_at) lines.push(`❌  ${name}  ยังไม่เข้างาน`);
        else if (!att.check_out_at) {
          lines.push(`🟢  ${name}  เข้า ${_displayTime(att.check_in_at)}  (${_hoursSince(att.check_in_at).toFixed(1)} ชม.)`);
        } else {
          const h = att.hours_worked || 0;
          lines.push(`${h >= 8 ? '✅' : '⚠️'}  ${name}  ${_displayTime(att.check_in_at)}–${_displayTime(att.check_out_at)}  (${h.toFixed(1)} ชม.)`);
        }
      }
      text = lines.join('\n');
    } else if (action === 'errors') {
      const errors = db.getRecentErrors(10);
      if (!errors.length) { text = '✅  ไม่มี error ครับ'; }
      else {
        const lines = ['⚠️  <b>Error ล่าสุด</b>\n'];
        for (const e of errors) {
          lines.push(`🔴  <code>${e.logged_at.slice(0,16).replace('T',' ')}</code>  <b>${_esc(e.error_type||'Error')}</b>${e.user_id ? `  👤 ${e.user_id}` : ''}\n  ${_esc((e.message||'').slice(0,100))}`);
        }
        text = lines.join('\n\n');
      }
    } else if (action === 'system') {
      const fs = require('fs');
      const { DB_PATH } = require('./db');
      const exists = fs.existsSync(DB_PATH);
      const size   = exists ? fs.statSync(DB_PATH).size : 0;
      text = `🔧  <b>System Info</b>\n\n💾  DB: ${size.toLocaleString()} bytes\n👥  นักแปล: ${db.getAllTranslatorSettings().length} คน\n📋  งาน: ${db.getAllJobsSummary().length} รายการ\n🔄  claim ค้าง: ${db.getAllActiveClaims().length} รายการ\n🕐  เซิร์ฟเวอร์: ${_bkkThaiDate(now)} ${_bkkTimeStr(now)} น.`;
    } else if (action === 'dump') {
      const translators = db.getAllTranslatorSettings();
      const claims = db.getAllActiveClaims();
      const errors = db.getRecentErrors(5);
      const attByUid = Object.fromEntries(db.getAllTodayAttendance(today).map(r => [r.user_id, r]));
      const lines = [`DEBUG DUMP  ${_bkkThaiDate(now)} ${_bkkTimeStr(now)}`, '='.repeat(38), `นักแปล ${translators.length} คน | claim ค้าง ${claims.length}`, '', '[ ยอดแปลวันนี้ ]'];
      for (const t of translators) {
        const ch = db.getCompletedChaptersOnDate(t.user_id, today);
        const att = attByUid[t.user_id] || {};
        lines.push(`  ${t.translator_name || t.user_id}: ${ch}ตอน  เข้า${_displayTime(att.check_in_at)||'-'} ออก${_displayTime(att.check_out_at)||'-'}`);
      }
      if (claims.length) {
        lines.push('', '[ งานค้าง ]');
        for (const cl of claims) lines.push(`  ${cl.translator_name} → ${cl.manga_title} ตอน${cl.chapter_from}-${cl.chapter_to}`);
      }
      if (errors.length) {
        lines.push('', '[ Errors ล่าสุด ]');
        for (const e of errors) lines.push(`  ${e.logged_at.slice(0,16).replace('T',' ')} ${e.error_type}: ${(e.message||'').slice(0,60)}`);
      }
      text = '<pre>' + lines.join('\n') + '</pre>';
    } else {
      text = 'ไม่รู้จักคำสั่งนี้';
    }

    text = _trunc(text);
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backKb }); }
    catch { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: backKb }); }
    return;
  }

  // ── CLAIM ─────────────────────────────────────────────────────────────────
  if (data.startsWith('claim:')) {
    const jobPk = parseInt(data.split(':')[1], 10);
    let job = db.getJobByPk(jobPk);
    if (job && job.announcement_msg_id !== query.message.message_id) job = null;
    if (!job) {
      job = db.getJobByAnnouncementMsgId(query.message.message_id);
      if (!job) {
        const msg = query.message;
        const cap = msg.caption || '';
        const mTitle  = cap.match(/ชื่อเรื่อง:\s*(.+)/);
        const mCount  = cap.match(/รวม\s*(\d+)\s*ตอน/);
        const mSender = cap.match(/ผู้ส่งงาน:\s*(.+)/);
        const title   = mTitle ? mTitle[1].trim() : `งาน_${jobPk}`;
        const cCount  = mCount ? parseInt(mCount[1]) : 1;
        const sender  = mSender ? mSender[1].trim() : '';
        let fid, fname, ftype;
        if (msg.document) { fid = msg.document.file_id; fname = msg.document.file_name || 'file.zip'; ftype = 'document'; }
        else if (msg.photo) { fid = msg.photo[msg.photo.length-1].file_id; fname = 'photo.jpg'; ftype = 'photo'; }
        else { await ctx.answerCbQuery('ไม่พบงานนี้', { show_alert: true }); return; }
        const { jobId } = db.createJob(fid, fname, ftype, title, '', 0, sender, cCount);
        db.setAnnouncementMsgId(jobId, msg.message_id);
        job = db.getJob(jobId);
      }
      if (!job) { await ctx.answerCbQuery('ไม่พบงานนี้', { show_alert: true }); return; }
    }
    if (['in_progress','done'].includes(job.status)) {
      await ctx.answerCbQuery('รับครบแล้วครับ ไม่มีตอนว่าง', { show_alert: true }); return;
    }
    const total = job.chapter_count || 1, claimed = job.chapter_claimed || 0, remaining = total - claimed;
    const chapterFrom = claimed + 1;
    if (db.getClaimByTranslator(job.job_id, user.id)) {
      await ctx.answerCbQuery('คุณรับงานนี้ไปแล้วครับ', { show_alert: true }); return;
    }
    const transName = _display(user);
    db.registerTranslator(user.id, transName);
    db.addClaim(job.job_id, chapterFrom, chapterFrom + remaining - 1, remaining, user.id, transName);
    await ctx.answerCbQuery(remaining > 1 ? `รับงาน ${remaining} ตอน แล้วครับ!` : 'รับงานแล้วครับ!');
    await _updateJobCard(job.job_id);
  }

  // ── CONFIRM / CANCEL PARTIAL ───────────────────────────────────────────────
  else if (data.startsWith('confirm_partial:')) {
    const confirmerId = parseInt(data.split(':')[1], 10);
    if (user.id !== confirmerId) { await ctx.answerCbQuery('ปุ่มนี้ไม่ใช่ของคุณครับ', { show_alert: true }); return; }
    const pending = _pendingClaims.get(confirmerId);
    _pendingClaims.delete(confirmerId);
    if (!pending) { await ctx.answerCbQuery('หมดเวลาหรือยืนยันไปแล้วครับ', { show_alert: true }); return; }
    db.registerTranslator(pending.translatorId, pending.translatorName);
    db.addClaim(pending.jobId, pending.chapterFrom, pending.chapterTo, pending.chapterCount, pending.translatorId, pending.translatorName);
    await ctx.answerCbQuery(`รับตอน ${pending.chapterFrom}–${pending.chapterTo}  (${pending.chapterCount} ตอน) แล้วครับ!`);
    try { await ctx.deleteMessage(); } catch {}
    await _updateJobCard(pending.jobId);
  }
  else if (data.startsWith('cancel_partial:')) {
    const confirmerId = parseInt(data.split(':')[1], 10);
    if (user.id !== confirmerId) { await ctx.answerCbQuery('ปุ่มนี้ไม่ใช่ของคุณครับ', { show_alert: true }); return; }
    _pendingClaims.delete(confirmerId);
    await ctx.answerCbQuery('ยกเลิกแล้วครับ');
    try { await ctx.deleteMessage(); } catch {}
  }

  // ── SUBMIT CLAIM ───────────────────────────────────────────────────────────
  else if (data.startsWith('submit_claim:')) {
    const claimId = parseInt(data.split(':')[1], 10);
    const state   = db.getState(user.id);
    const fileId  = state.pending_file_id;
    const fileType = state.file_type || 'document';
    if (!fileId) { await ctx.answerCbQuery('ไม่พบไฟล์ กรุณาส่งไฟล์ใหม่อีกครั้งครับ', { show_alert: true }); return; }
    const active = db.getUserActiveClaims(user.id);
    if (!active.find(c => c.id === claimId)) {
      await ctx.answerCbQuery('งานนี้ไม่มีอยู่แล้ว หรือส่งไปแล้วครับ', { show_alert: true });
      db.clearState(user.id); return;
    }
    const { ok, err, job: updJob } = db.completeClaim(claimId, user.id, fileId, fileType);
    if (!ok) { await ctx.answerCbQuery(`ผิดพลาด: ${err}`, { show_alert: true }); return; }
    db.clearState(user.id);
    const allClaims = db.getClaims(updJob.job_id);
    let claim = allClaims.find(c => c.id === claimId) || { chapter_from: 1, chapter_to: 1, chapter_count: 1, translator_name: _display(user) };
    claim.translated_file_id = fileId; claim.translated_type = fileType;
    const title = updJob.manga_title || updJob.job_id;
    const { chapter_from: fr, chapter_to: to, chapter_count: cnt } = claim;
    const rangeLbl = cnt > 1 ? `ตอน ${fr}–${to}  (${cnt} ตอน)` : `ตอน ${fr}`;
    await ctx.answerCbQuery(`ส่ง ${title}  ${rangeLbl} เสร็จแล้ว!`);
    try { await ctx.editMessageText(`✅  ส่ง <b>${title}  —  ${rangeLbl}</b> เสร็จแล้วครับ!`, { parse_mode: 'HTML' }); } catch {}
    await _deliverDone(user, updJob.job_id, claim);
    await _updateJobCard(updJob.job_id);
  }

  // ── SELECT DONE ────────────────────────────────────────────────────────────
  else if (data === 'select_done') {
    const claims = db.getUserActiveClaims(user.id);
    if (!claims.length) { await ctx.answerCbQuery('ไม่มีงานที่รับไว้ครับ', { show_alert: true }); return; }
    await ctx.answerCbQuery();
    const kb = claims.map(cl => {
      const title = cl.manga_title || cl.job_id;
      const { chapter_from: fr, chapter_to: to, chapter_count: cnt } = cl;
      return [_ikBtn(cnt > 1 ? `📖  ${title}  |  ตอน ${fr}–${to}  (${cnt} ตอน)` : `📖  ${title}  |  ตอน ${fr}`, `ready_done_claim:${cl.id}`)];
    });
    await ctx.reply('📋  เลือกงานที่แปลเสร็จแล้วครับ:', { reply_markup: { inline_keyboard: kb } });
  }

  // ── READY DONE CLAIM ───────────────────────────────────────────────────────
  else if (data.startsWith('ready_done_claim:')) {
    const claimId = parseInt(data.split(':')[1], 10);
    db.setState(user.id, { action: 'send_done', claim_id: claimId });
    await ctx.answerCbQuery('เลือกแล้ว โพสต์ไฟล์ได้เลย');
    try { await ctx.editMessageText(`✅  ${_display(user)}\nโพสต์ไฟล์แปลในห้องนี้ได้เลยครับ 📤`, { parse_mode: 'HTML' }); } catch {}
  }

  // ── NEW JOB ────────────────────────────────────────────────────────────────
  else if (data === 'new_job') {
    await ctx.answerCbQuery('โพสต์ไฟล์พร้อม caption ได้เลยครับ');
    await ctx.reply(`📂  ${_display(user)}\nโพสต์ไฟล์ ZIP พร้อม caption:\n<code>ชื่อเรื่อง | ตอน</code>\n\nตัวอย่าง: <code>Solo Max-Level Newbie | 1-10</code>`,
      { parse_mode: 'HTML' });
  }

  // ── CANCEL CLAIM ───────────────────────────────────────────────────────────
  else if (data.startsWith('cancel:')) {
    const jobId = data.split(':', 2)[1];
    const claim = db.getClaimByTranslator(jobId, user.id);
    if (claim && db.cancelClaim(claim.id, user.id)) {
      await ctx.answerCbQuery(`ยกเลิกงาน ${jobId} แล้วครับ`);
      try { await ctx.editMessageText(`❌ ยกเลิกงาน ${jobId} แล้ว`); } catch {}
      await _updateJobCard(jobId);
    } else {
      await ctx.answerCbQuery('ยกเลิกไม่ได้', { show_alert: true });
    }
  }

  // ── GROUP CHECKIN / CHECKOUT ───────────────────────────────────────────────
  else if (data === 'grp_checkin' || data === 'grp_checkout') {
    const now   = new Date();
    const today = _bkkISODate(now);
    const ts    = _bkkISOTS(now);
    const name  = _display(user);
    if (data === 'grp_checkin') {
      db.checkin(user.id, name, today, ts);
      await ctx.answerCbQuery(`✅ บันทึกเข้างาน ${_bkkTimeStr(now)} น. แล้วครับ!`);
      setTimeout(async () => {
        const tid = _topicId('topic_report'), gid = _groupId();
        if (!gid || !tid) return;
        const att2 = db.getTodayAttendance(user.id, today);
        if (att2 && att2.check_out_at) return;
        try {
          await _bot.telegram.sendMessage(gid, `⏰  <b>${_esc(name)}</b>  ครบ 8 ชม. แล้วครับ`, { parse_mode: 'HTML', message_thread_id: tid });
        } catch {}
      }, 8 * 3600 * 1000);
    } else {
      const hours = db.checkout(user.id, today, ts);
      if (hours === null) { await ctx.answerCbQuery('ยังไม่ได้กดเข้างานครับ', { show_alert: true }); return; }
      const msg = `บันทึกออกงาน ${_bkkTimeStr(now)} น. รวม ${hours.toFixed(1)} ชม.${hours < MIN_HOURS ? '\n⚠️ ยังไม่ครบ 8 ชม. นะครับ' : ''}`;
      await ctx.answerCbQuery(msg, { show_alert: true });
    }
    // update group checkin card
    const cardMsgId = db.getConfig('checkin_card_msg_id');
    const cardDate  = db.getConfig('checkin_card_date');
    if (cardMsgId && cardDate === today) {
      const gid = _groupId();
      const translators = db.getAllTranslatorSettings();
      const attByUid = Object.fromEntries(db.getAllTodayAttendance(today).map(r => [r.user_id, r]));
      const wd = _bkkWeekday(new Date());
      const lines = [`📋  เข้า-ออกงาน  ${_bkkThaiDate()}\n`];
      for (const t of translators) {
        const tname = t.translator_name || String(t.user_id);
        if (wd === t.day_off) { lines.push(`  🏖️  ${tname}  (วันหยุด)`); continue; }
        const att = attByUid[t.user_id];
        if (!att || !att.check_in_at) lines.push(`  ⬜  ${tname}`);
        else if (!att.check_out_at) lines.push(`  🟢  ${tname}  เข้า ${_displayTime(att.check_in_at)}`);
        else {
          const h = att.hours_worked || 0;
          lines.push(`  ${h >= MIN_HOURS ? '✅' : '⚠️'}  ${tname}  ${_displayTime(att.check_in_at)}–${_displayTime(att.check_out_at)}  (${h.toFixed(1)} ชม.)`);
        }
      }
      const markup = _ik([_ikBtn('🟢  เข้างาน', 'grp_checkin'), _ikBtn('🔴  ออกงาน', 'grp_checkout')]);
      const checkinTid = _topicId('topic_checkin');
      try {
        await _bot.telegram.editMessageText(gid, parseInt(cardMsgId, 10), null, lines.join('\n'),
          { reply_markup: markup, ...(checkinTid ? { message_thread_id: checkinTid } : {}) });
      } catch {}
    }
    // send notification
    const tidVal = db.getConfig('topic_checkin');
    if (tidVal) {
      const now2 = new Date(), timeStr = _bkkTimeStr(now2);
      let notify;
      if (data === 'grp_checkin') {
        notify = `🟢  ${name}  เข้างาน  ${timeStr} น.`;
      } else {
        const att3 = db.getTodayAttendance(user.id, _bkkISODate(now2));
        const hw = (att3 && att3.hours_worked) || 0;
        notify = `🔴  ${name}  ออกงาน  ${timeStr} น.  (${hw >= MIN_HOURS ? '✅' : '⚠️'} รวม ${hw.toFixed(1)} ชม.)`;
      }
      try { await _bot.telegram.sendMessage(_groupId(), notify, { message_thread_id: parseInt(tidVal, 10) }); } catch {}
    }
  }

  // ── DM CHECKIN / CHECKOUT ──────────────────────────────────────────────────
  else if (data === 'checkin' || data === 'checkout') {
    const now   = new Date();
    const today = _bkkISODate(now);
    const ts    = _bkkISOTS(now);
    const name  = _display(user);
    if (data === 'checkin') {
      db.checkin(user.id, name, today, ts);
      await ctx.answerCbQuery(`เข้างานแล้ว! ${_bkkTimeStr(now)} น.`);
    } else {
      const hours = db.checkout(user.id, today, ts);
      if (hours === null) { await ctx.answerCbQuery('ยังไม่ได้กดเข้างานครับ', { show_alert: true }); return; }
      await ctx.answerCbQuery(
        hours < MIN_HOURS ? `ออกงานแล้ว (${hours.toFixed(1)} ชม.) ⚠️ ยังไม่ครบ 8 ชม. นะครับ` : `ออกงานแล้ว! รวม ${hours.toFixed(1)} ชม.`,
        { show_alert: hours < MIN_HOURS });
    }
    const { text, markup } = _attendanceCard(user.id, name);
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }); } catch {}
    // update stored card msg id
    const existingId = db.getConfig(`att_card_msg_${user.id}`);
    if (!existingId) db.setConfig(`att_card_msg_${user.id}`, query.message.message_id);
  }

  // ── DAYOFF ─────────────────────────────────────────────────────────────────
  else if (data.startsWith('dayoff:')) {
    const day = parseInt(data.split(':')[1], 10);
    db.setTranslatorDayoff(user.id, _display(user), day);
    await ctx.answerCbQuery(`ตั้งวันหยุด: วัน${DAY_NAMES[day]} แล้วครับ!`);
    if (query.message.chat.type === 'private') {
      try { await ctx.editMessageText(`✅  วันหยุดของ ${_display(user)}: <b>วัน${DAY_NAMES[day]}</b>`, { parse_mode: 'HTML' }); } catch {}
      const cardMsgId = db.getConfig('dayoff_card_msg_id');
      if (cardMsgId) {
        const gid = _groupId(); const tidVal = db.getConfig('topic_dayoff');
        try {
          await _bot.telegram.editMessageText(gid, parseInt(cardMsgId,10), null, _renderDayoffGroupCard(),
            { reply_markup: _dayoffKeyboard(), ...(tidVal ? { message_thread_id: parseInt(tidVal,10) } : {}) });
        } catch {}
      }
    } else {
      try { await ctx.editMessageText(_renderDayoffGroupCard(), { reply_markup: _dayoffKeyboard() }); } catch {}
      try {
        const tidVal = db.getConfig('topic_dayoff');
        await _bot.telegram.sendMessage(_groupId(), `📅  ${_display(user)}  เลือกหยุดวัน${DAY_NAMES[day]}`,
          { ...(tidVal ? { message_thread_id: parseInt(tidVal,10) } : {}) });
      } catch {}
    }
  }

  // ── FIXCLAIMS ──────────────────────────────────────────────────────────────
  else if (data.startsWith('fixclaims:')) {
    if (user.id !== ADMIN_ID) { await ctx.answerCbQuery('ไม่มีสิทธิ์ครับ', { show_alert: true }); return; }
    const action = data.split(':')[1];
    if (action === 'confirm') {
      const count = db.forceCompleteAllClaims();
      await ctx.answerCbQuery(`✅ fix ${count} claim แล้วครับ!`);
      try { await ctx.editMessageText(`✅  fix เสร็จแล้วครับ!\n\nmark <b>${count} claim</b> เป็นเสร็จแล้ว`, { parse_mode: 'HTML' }); } catch {}
    } else {
      await ctx.answerCbQuery('ยกเลิกแล้วครับ');
      try { await ctx.editMessageText('❌ ยกเลิกแล้ว'); } catch {}
    }
  }

  else { await ctx.answerCbQuery(); }
}

// ── Message router ────────────────────────────────────────────────────────────

async function messageHandler(ctx) {
  const msg  = ctx.message;
  const chat = ctx.chat;
  if (!msg) return;

  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (msg.document || msg.photo) await handleGroupFile(ctx);
  } else if (chat.type === 'private') {
    if (msg.document) await handleDocument(ctx);
    else if (msg.photo) await handlePhoto(ctx);
    else if (msg.text && !msg.text.startsWith('/')) await handleText(ctx);
  }
}

// ── Exports for scheduler (attendance card) ───────────────────────────────────

module.exports = {
  setup,
  startCommand, settopicCommand, setgroupCommand, dayoffCommand, boardCommand,
  postcheckinCommand, postdayoffCommand, alljobsCommand, teamstatsCommand,
  adminCommand, fixclaimsCommand, dbinfoCommand, usersCommand,
  resetclaimCommand, addchaptersCommand, topicsCommand, testNotifyCommand,
  callbackHandler, messageHandler,
  // for scheduler
  attendanceCard: _attendanceCard,
  bkkWeekday: _bkkWeekday, bkkISODate: _bkkISODate, bkkISOTS: _bkkISOTS,
  bkkTimeStr: _bkkTimeStr, bkkThaiDate: _bkkThaiDate,
  displayTime: _displayTime, esc: _esc,
  groupId: _groupId, topicId: _topicId,
  DAY_NAMES,
};
