'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR ||
  (fs.existsSync('/data') ? '/data' : os.tmpdir());
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'manga_bot.db');

let _db;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

// ── Bangkok time helpers ──────────────────────────────────────────────────────

const BKK_OFFSET = 7 * 3600 * 1000;

function _bkkNow() { return new Date(Date.now() + BKK_OFFSET); }

// Bangkok ISO datetime string (no 'Z') — used for storing timestamps
function _bkkNowISO() { return _bkkNow().toISOString().slice(0, 19); }

// Bangkok date string YYYY-MM-DD — used for daily queries
function _bkkTodayStr() { return _bkkNow().toISOString().slice(0, 10); }

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id              TEXT UNIQUE,
      file_id             TEXT,
      file_name           TEXT,
      file_type           TEXT DEFAULT 'document',
      translated_file_id  TEXT,
      translated_type     TEXT,
      manga_title         TEXT,
      episode             TEXT,
      sender_user_id      INTEGER,
      sender_name         TEXT,
      translator_user_id  INTEGER,
      translator_name     TEXT,
      status              TEXT DEFAULT 'pending',
      created_at          TEXT,
      claimed_at          TEXT,
      completed_at        TEXT,
      announcement_msg_id INTEGER,
      chapter_count       INTEGER DEFAULT 1,
      chapter_claimed     INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_claims (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id             TEXT NOT NULL,
      chapter_from       INTEGER NOT NULL,
      chapter_to         INTEGER NOT NULL,
      chapter_count      INTEGER NOT NULL,
      translator_id      INTEGER NOT NULL,
      translator_name    TEXT,
      status             TEXT DEFAULT 'in_progress',
      claimed_at         TEXT,
      completed_at       TEXT,
      completed_date     TEXT,
      translated_file_id TEXT,
      translated_type    TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS user_states (
      user_id INTEGER PRIMARY KEY,
      data    TEXT
    );
    CREATE TABLE IF NOT EXISTS translator_settings (
      user_id         INTEGER PRIMARY KEY,
      translator_name TEXT,
      day_off         INTEGER DEFAULT 6
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      translator_name TEXT,
      work_date       TEXT NOT NULL,
      check_in_at     TEXT,
      check_out_at    TEXT,
      hours_worked    REAL,
      UNIQUE(user_id, work_date)
    );
    CREATE TABLE IF NOT EXISTS error_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      logged_at   TEXT NOT NULL,
      error_type  TEXT,
      message     TEXT,
      traceback   TEXT,
      user_id     INTEGER,
      user_action TEXT
    );
  `);

  // ── schema migrations ───────────────────────────────────────────────────────
  for (const [col, def] of [
    ['announcement_msg_id', 'INTEGER'],
    ['chapter_count',       'INTEGER DEFAULT 1'],
    ['chapter_claimed',     'INTEGER DEFAULT 0'],
  ]) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${def}`); } catch {}
  }

  // Add completed_date to job_claims (Bangkok date YYYY-MM-DD)
  try { db.exec('ALTER TABLE job_claims ADD COLUMN completed_date TEXT'); } catch {}

  // Backfill completed_date for existing rows that have completed_at in UTC
  // date(datetime(completed_at, '+7 hours')) converts UTC ISO to Bangkok date
  db.exec(`
    UPDATE job_claims
    SET completed_date = date(datetime(completed_at, '+7 hours'))
    WHERE completed_date IS NULL AND completed_at IS NOT NULL AND status = 'done'
  `);

  // Create index for fast date-range queries
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_claims_done ON job_claims(translator_id, completed_date) WHERE status=\'done\''); } catch {}

  console.log(`DB ready: ${DB_PATH}`);
}

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig(key, defaultVal = null) {
  const row = getDb().prepare('SELECT value FROM config WHERE key=?').get(key);
  return row ? row.value : (process.env[key.toUpperCase()] ?? defaultVal);
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

function _makeJobId(mangaTitle, episode = '') {
  const db = getDb();
  const title = (mangaTitle || 'งาน').slice(0, 35).trim();
  let base = episode ? `${title} | ${episode}` : title.slice(0, 40);
  if (!db.prepare('SELECT id FROM jobs WHERE job_id=?').get(base)) return base;
  for (let i = 2; ; i++) {
    const c = `${base} (${i})`;
    if (!db.prepare('SELECT id FROM jobs WHERE job_id=?').get(c)) return c;
  }
}

function createJob(fileId, fileName, fileType, mangaTitle, episode, senderUserId, senderName, chapterCount = 1) {
  const jobId = _makeJobId(mangaTitle, episode);
  const stmt = getDb().prepare(`
    INSERT INTO jobs (job_id,file_id,file_name,file_type,manga_title,episode,
      sender_user_id,sender_name,status,created_at,chapter_count)
    VALUES (?,?,?,?,?,?,?,?,'pending',?,?)
  `);
  const info = stmt.run(jobId, fileId, fileName, fileType, mangaTitle, episode,
    senderUserId, senderName, _bkkNowISO(), Math.max(1, chapterCount));
  return { jobId, pk: info.lastInsertRowid };
}

function getJobByPk(pk) {
  return getDb().prepare('SELECT * FROM jobs WHERE id=?').get(pk) ?? null;
}

function getJob(jobId) {
  return getDb().prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId) ?? null;
}

function getAllJobsSummary() {
  return getDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').all();
}

function getTodayCompletedJobs() {
  const today = _bkkTodayStr();
  return getDb().prepare("SELECT * FROM jobs WHERE status='done' AND completed_at LIKE ?")
    .all(`${today}%`);
}

function setAnnouncementMsgId(jobId, msgId) {
  getDb().prepare('UPDATE jobs SET announcement_msg_id=? WHERE job_id=?').run(msgId, jobId);
}

function getJobByAnnouncementMsgId(msgId) {
  return getDb().prepare('SELECT * FROM jobs WHERE announcement_msg_id=?').get(msgId) ?? null;
}

// ── Claims ────────────────────────────────────────────────────────────────────

function addClaim(jobId, chapterFrom, chapterTo, chapterCount, translatorId, translatorName) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO job_claims (job_id,chapter_from,chapter_to,chapter_count,
      translator_id,translator_name,claimed_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(jobId, chapterFrom, chapterTo, chapterCount,
    translatorId, translatorName, _bkkNowISO());

  db.prepare('UPDATE jobs SET chapter_claimed = chapter_claimed + ? WHERE job_id=?')
    .run(chapterCount, jobId);

  const row = db.prepare('SELECT chapter_count, chapter_claimed FROM jobs WHERE job_id=?').get(jobId);
  if (row) {
    const newStatus = row.chapter_claimed >= row.chapter_count ? 'in_progress' : 'partial';
    db.prepare('UPDATE jobs SET status=? WHERE job_id=?').run(newStatus, jobId);
  }
  return info.lastInsertRowid;
}

function getClaims(jobId) {
  return getDb().prepare(`
    SELECT * FROM job_claims WHERE job_id=? AND status != 'cancelled' ORDER BY chapter_from ASC
  `).all(jobId);
}

function getClaimByTranslator(jobId, translatorId) {
  return getDb().prepare(`
    SELECT * FROM job_claims WHERE job_id=? AND translator_id=? AND status='in_progress'
  `).get(jobId, translatorId) ?? null;
}

function completeClaim(claimId, translatorId, fileId, fileType) {
  const db = getDb();
  const claim = db.prepare('SELECT * FROM job_claims WHERE id=?').get(claimId);
  if (!claim) return { ok: false, err: 'ไม่พบงานนี้' };
  if (claim.status !== 'in_progress') return { ok: false, err: `สถานะ: ${claim.status}` };
  if (claim.translator_id !== translatorId) return { ok: false, err: 'งานนี้ไม่ใช่ของคุณ' };

  const nowISO  = _bkkNowISO();
  const todayStr = _bkkTodayStr();

  db.prepare(`
    UPDATE job_claims
    SET status='done', translated_file_id=?, translated_type=?, completed_at=?, completed_date=?
    WHERE id=?
  `).run(fileId, fileType, nowISO, todayStr, claimId);

  db.prepare('UPDATE jobs SET translated_file_id=?, translated_type=? WHERE job_id=?')
    .run(fileId, fileType, claim.job_id);

  const stillActive = db.prepare(`
    SELECT COUNT(*) AS c FROM job_claims WHERE job_id=? AND status='in_progress'
  `).get(claim.job_id).c;

  if (stillActive === 0) {
    db.prepare("UPDATE jobs SET status='done', completed_at=? WHERE job_id=?")
      .run(nowISO, claim.job_id);
  }

  const job = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(claim.job_id);
  return { ok: true, job };
}

function cancelClaim(claimId, userId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT job_id, chapter_count FROM job_claims WHERE id=? AND translator_id=? AND status='in_progress'
  `).get(claimId, userId);
  if (!row) return false;
  db.prepare("UPDATE job_claims SET status='cancelled' WHERE id=?").run(claimId);
  db.prepare('UPDATE jobs SET chapter_claimed = MAX(0, chapter_claimed - ?) WHERE job_id=?')
    .run(row.chapter_count, row.job_id);
  const r2 = db.prepare('SELECT chapter_claimed FROM jobs WHERE job_id=?').get(row.job_id);
  if (r2 != null) {
    const newStatus = r2.chapter_claimed === 0 ? 'pending' : 'partial';
    db.prepare('UPDATE jobs SET status=? WHERE job_id=?').run(newStatus, row.job_id);
    if (newStatus === 'pending') {
      db.prepare('UPDATE jobs SET translator_user_id=NULL, translator_name=NULL WHERE job_id=?')
        .run(row.job_id);
    }
  }
  return true;
}

function getUserActiveClaims(userId) {
  return getDb().prepare(`
    SELECT jc.*, j.manga_title, j.episode, j.sender_user_id, j.sender_name,
           j.file_id AS job_file_id, j.file_type AS job_file_type, j.announcement_msg_id
    FROM job_claims jc
    JOIN jobs j ON jc.job_id = j.job_id
    WHERE jc.translator_id=? AND jc.status='in_progress'
    ORDER BY jc.claimed_at ASC
  `).all(userId);
}

function getUserDoneClaims(userId) {
  return getDb().prepare(`
    SELECT jc.*, j.manga_title, j.episode
    FROM job_claims jc
    JOIN jobs j ON jc.job_id = j.job_id
    WHERE jc.translator_id=? AND jc.status='done'
    ORDER BY jc.completed_at DESC LIMIT 5
  `).all(userId);
}

function resetDoneClaims(userId) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE job_claims
    SET status='in_progress', completed_at=NULL, completed_date=NULL,
        translated_file_id=NULL, translated_type=NULL
    WHERE translator_id=? AND status='done'
  `).run(userId);
  if (info.changes > 0) {
    const jobs = db.prepare(`
      SELECT DISTINCT job_id FROM job_claims WHERE translator_id=? AND status='in_progress'
    `).all(userId);
    for (const { job_id } of jobs) {
      const done = db.prepare(`
        SELECT COUNT(*) AS c FROM job_claims WHERE job_id=? AND status='done'
      `).get(job_id).c;
      db.prepare(`
        UPDATE jobs SET status=?, completed_at=NULL WHERE job_id=? AND status IN ('done','partial','in_progress')
      `).run(done > 0 ? 'partial' : 'in_progress', job_id);
    }
  }
  return info.changes;
}

function getUserInprogressChapterCount(userId) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(chapter_count), 0) AS total FROM job_claims WHERE translator_id=? AND status='in_progress'
  `).get(userId);
  return row ? row.total : 0;
}

function getAllActiveClaims() {
  return getDb().prepare(`
    SELECT jc.*, j.manga_title, j.episode
    FROM job_claims jc
    JOIN jobs j ON jc.job_id = j.job_id
    WHERE jc.status='in_progress'
    ORDER BY jc.translator_id, jc.claimed_at
  `).all();
}

function forceCompleteAllClaims() {
  const db = getDb();
  const nowISO   = _bkkNowISO();
  const todayStr = _bkkTodayStr();
  const info = db.prepare(`
    UPDATE job_claims SET status='done', completed_at=?, completed_date=? WHERE status='in_progress'
  `).run(nowISO, todayStr);
  db.prepare(`
    UPDATE jobs SET status='done', completed_at=?
    WHERE status IN ('in_progress','partial')
    AND (SELECT COUNT(*) FROM job_claims WHERE job_claims.job_id = jobs.job_id AND job_claims.status='in_progress') = 0
  `).run(nowISO);
  return info.changes;
}

// ── Translators ───────────────────────────────────────────────────────────────

function registerTranslator(userId, translatorName) {
  getDb().prepare(`
    INSERT INTO translator_settings (user_id, translator_name, day_off)
    VALUES (?, ?, 6)
    ON CONFLICT(user_id) DO UPDATE SET translator_name=excluded.translator_name
  `).run(userId, translatorName);
}

function setTranslatorDayoff(userId, translatorName, dayOff) {
  getDb().prepare(`
    INSERT INTO translator_settings (user_id, translator_name, day_off)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET translator_name=excluded.translator_name, day_off=excluded.day_off
  `).run(userId, translatorName, dayOff);
}

function getTranslatorDayoff(userId) {
  const row = getDb().prepare('SELECT day_off FROM translator_settings WHERE user_id=?').get(userId);
  return row ? row.day_off : null;
}

function getAllTranslatorSettings() {
  return getDb().prepare('SELECT * FROM translator_settings ORDER BY translator_name').all();
}

// ── Chapter stats ─────────────────────────────────────────────────────────────
// Both functions now use the completed_date column (Bangkok date YYYY-MM-DD)
// which is set explicitly when a claim is completed — no timezone ambiguity.

function getCompletedChaptersOnDate(userId, dateStr) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(chapter_count), 0) AS total
    FROM job_claims
    WHERE translator_id=? AND status='done' AND completed_date = ?
  `).get(userId, dateStr);
  return row ? row.total : 0;
}

function getCompletedChaptersInMonth(userId, year, month) {
  const prefix = `${String(year)}-${String(month).padStart(2, '0')}`;
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(chapter_count), 0) AS total
    FROM job_claims
    WHERE translator_id=? AND status='done' AND completed_date LIKE ?
  `).get(userId, `${prefix}%`);
  return row ? row.total : 0;
}

function addManualChapters(userId, translatorName, chapterCount, dateStr) {
  const { randomBytes } = require('crypto');
  const jobId = `manual_${dateStr}_${userId}_${randomBytes(3).toString('hex')}`;
  const completedAt = `${dateStr}T12:00:00`;
  const db = getDb();
  db.prepare(`
    INSERT INTO jobs (job_id,file_id,file_name,file_type,manga_title,episode,
      sender_user_id,sender_name,status,created_at,chapter_count)
    VALUES (?, '', 'manual', 'document', 'บันทึกย้อนหลัง (Admin)', '',
      0, 'Admin', 'done', ?, ?)
  `).run(jobId, completedAt, chapterCount);
  db.prepare(`
    INSERT INTO job_claims (job_id,chapter_from,chapter_to,chapter_count,
      translator_id,translator_name,status,claimed_at,completed_at,completed_date)
    VALUES (?,1,?,?,?,?,'done',?,?,?)
  `).run(jobId, chapterCount, chapterCount, userId, translatorName,
    completedAt, completedAt, dateStr);
}

// ── Attendance ────────────────────────────────────────────────────────────────

function checkin(userId, translatorName, workDate, timestamp) {
  getDb().prepare(`
    INSERT INTO attendance (user_id, translator_name, work_date, check_in_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, work_date) DO UPDATE SET
      check_in_at=excluded.check_in_at, check_out_at=NULL, hours_worked=NULL
  `).run(userId, translatorName, workDate, timestamp);
}

function checkout(userId, workDate, timestamp) {
  const db = getDb();
  const row = db.prepare('SELECT check_in_at FROM attendance WHERE user_id=? AND work_date=?')
    .get(userId, workDate);
  if (!row || !row.check_in_at) return null;
  // Both timestamps are Bangkok ISO strings (no Z). Subtraction gives correct elapsed hours
  // because both are offset from UTC by the same 7h constant.
  const msElapsed = new Date(timestamp) - new Date(row.check_in_at);
  const hours = Math.round((msElapsed / 3600000) * 100) / 100;
  db.prepare('UPDATE attendance SET check_out_at=?, hours_worked=? WHERE user_id=? AND work_date=?')
    .run(timestamp, hours, userId, workDate);
  return hours;
}

function getTodayAttendance(userId, workDate) {
  return getDb().prepare('SELECT * FROM attendance WHERE user_id=? AND work_date=?')
    .get(userId, workDate) ?? null;
}

function getAllTodayAttendance(workDate) {
  return getDb().prepare('SELECT * FROM attendance WHERE work_date=? ORDER BY check_in_at')
    .all(workDate);
}

// ── State ─────────────────────────────────────────────────────────────────────

function setState(userId, data) {
  getDb().prepare('INSERT OR REPLACE INTO user_states (user_id, data) VALUES (?, ?)')
    .run(userId, JSON.stringify(data));
}

function getState(userId) {
  const row = getDb().prepare('SELECT data FROM user_states WHERE user_id=?').get(userId);
  return row ? JSON.parse(row.data) : {};
}

function clearState(userId) {
  getDb().prepare('DELETE FROM user_states WHERE user_id=?').run(userId);
}

// ── Error log ─────────────────────────────────────────────────────────────────

function logError(errorType, message, traceback = null, userId = null, userAction = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO error_log (logged_at, error_type, message, traceback, user_id, user_action)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(_bkkNowISO(), errorType, message, traceback, userId, userAction);
  db.prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 20)').run();
}

function getRecentErrors(limit = 20) {
  return getDb().prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  DB_PATH,
  init, getConfig, setConfig,
  createJob, getJobByPk, getJob, getAllJobsSummary, getTodayCompletedJobs,
  setAnnouncementMsgId, getJobByAnnouncementMsgId,
  addClaim, getClaims, getClaimByTranslator, completeClaim, cancelClaim,
  getUserActiveClaims, getUserDoneClaims, resetDoneClaims,
  getUserInprogressChapterCount, getAllActiveClaims, forceCompleteAllClaims,
  registerTranslator, setTranslatorDayoff, getTranslatorDayoff, getAllTranslatorSettings,
  getCompletedChaptersOnDate, getCompletedChaptersInMonth, addManualChapters,
  checkin, checkout, getTodayAttendance, getAllTodayAttendance,
  setState, getState, clearState,
  logError, getRecentErrors,
};
