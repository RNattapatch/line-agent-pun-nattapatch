/*
 * ตัวตั้งเวลา — รายงานเย็นรายวัน (เวลาไทย) + ยามแจ้งด่วนทุก 2 นาที
 *
 * ═══ ทำไมคิดเวลาเอง ไม่ใช้ cron ของเครื่อง ═══
 * cron อยู่นอก container ส่วนโค้ดอยู่ใน container — ถ้าแยกกัน วันหนึ่งจะมีคนย้ายเครื่อง
 * แล้วลืมย้าย cron ไปด้วย รายงานเย็นจะเงียบไปเฉย ๆ โดยไม่มี error อะไรให้เห็น
 * ตั้งเวลาไว้ในตัวโปรแกรมเอง = ย้ายไปไหนก็ติดไปด้วยเสมอ
 *
 * ═══ ทำไมคิด offset เองได้ ═══
 * ไทยเป็น UTC+7 ตายตัว ไม่มี DST มาตั้งแต่ปี 2495 จึงคิดตรง ๆ ได้ว่า
 * 18:30 ของไทย = 11:30 UTC ของวันเดียวกัน — ไม่ต้องพึ่งตาราง timezone ที่อาจเก่าในภาพ container
 *
 * ═══ รีสตาร์ตแล้วต้องไม่ข้ามวัน ═══
 * setTimeout หายไปพร้อม process ทุกครั้งที่ deploy — ถ้า deploy ตอน 18:31 พอดี
 * รายงานของวันนั้นจะหายไปเงียบ ๆ ตรงนี้จึงจำไว้ว่า "รันวันไหนไปแล้ว" ลงดิสก์
 * แล้วตอนบูตถ้าเลยเวลาของวันนี้ไปแล้วแต่ยังไม่เคยรัน จะรันตามให้ทันที
 */

import fs from "node:fs";
import path from "node:path";

import { bangkokDate, eventsDir } from "./customer-events.js";

const FILE_MODE = 0o600;

/* เวลารายงานเย็น — ตั้งได้ทาง .env โดยไม่ต้องแก้โค้ด */
export const DEFAULT_EVENING_AT = "18:30";

const BANGKOK_OFFSET_HOURS = 7;

export function parseHHMM(value, fallback = DEFAULT_EVENING_AT) {
  const m = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return parseHHMM(fallback, "18:30");
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return parseHHMM(fallback, "18:30");
  return { hour: h, minute: min, label: `${String(h).padStart(2, "0")}:${m[2]}` };
}

/* เวลา UTC (epoch ms) ของ "HH:MM เวลาไทย" ในวันไทยที่ระบุ */
export function bangkokWallClockToUtc(date, { hour, minute }) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - BANGKOK_OFFSET_HOURS, minute, 0, 0);
}

/* รอบถัดไปหลังจาก now — ถ้าวันนี้เลยเวลาไปแล้วก็เป็นพรุ่งนี้ */
export function nextRunAt(now, at) {
  const today = bangkokDate(now);
  const todayRun = bangkokWallClockToUtc(today, at);
  if (todayRun > now.getTime()) return todayRun;
  const tomorrow = bangkokDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  return bangkokWallClockToUtc(tomorrow, at);
}

export function createScheduler({
  eveningAt = process.env.EVENING_REPORT_AT,
  runEvening,
  urgentTick,
  urgentMs = 2 * 60 * 1000,
  dir = eventsDir(),
  now = () => new Date(),
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  log = console,
} = {}) {
  const at = parseHHMM(eveningAt);
  const stateFile = path.join(dir, "scheduler.json");
  let dailyTimer = null;
  let urgentTimer = null;

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return {};
    }
  };

  const writeState = (state) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.scheduler.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, stateFile);
  };

  /* รันรายงานของวันไทยที่ระบุ แล้วจำไว้ว่ารันแล้ว — กันรันซ้ำเมื่อ deploy หลายรอบในวันเดียว */
  async function runFor(date, { reason }) {
    const state = readState();
    if (state.last_evening_run === date) {
      log.log?.(`🌆 รายงานเย็นของ ${date} ส่งไปแล้ว ไม่ส่งซ้ำ (${reason})`);
      return { skipped: true, date };
    }

    try {
      const result = await runEvening({ date, testRun: false });
      writeState({ ...state, last_evening_run: date, last_evening_at: new Date(now()).toISOString(), reason });
      log.log?.(`🌆 ส่งรายงานเย็นของ ${date} แล้ว (${reason} · deliver=${result.deliver})`);
      return { ...result, skipped: false };
    } catch (err) {
      /* ส่งไม่สำเร็จต้องไม่ถูกจำว่า "รันแล้ว" ไม่งั้นวันนั้นจะไม่มีรายงานเลยตลอดกาล */
      log.error?.("ส่งรายงานเย็นไม่สำเร็จ:", err?.message ?? err);
      return { failed: true, date };
    }
  }

  function arm() {
    const when = nextRunAt(new Date(now()), at);
    const waitMs = when - now();
    dailyTimer = timers.setTimeout(async () => {
      await runFor(bangkokDate(new Date(when)), { reason: "scheduler" });
      arm(); // ตั้งรอบถัดไปต่อทันที ไม่ใช้ setInterval เพราะวันหนึ่งไม่ได้ยาว 24 ชม.เป๊ะเสมอไป
    }, waitMs);
    dailyTimer?.unref?.();
    return { when, waitMs };
  }

  return {
    eveningAt: at.label,
    stateFile,
    runFor,

    /* รันตามให้ถ้าเลยเวลาของวันนี้ไปแล้วแต่ยังไม่เคยรัน — เรียกตอนบูต */
    async catchUp() {
      const today = bangkokDate(new Date(now()));
      const due = bangkokWallClockToUtc(today, at);
      if (now() < due) return { caughtUp: false, date: today };
      const res = await runFor(today, { reason: "catch-up หลังรีสตาร์ต" });
      return { caughtUp: !res.skipped, date: today };
    },

    start() {
      const { when, waitMs } = arm();
      if (urgentTick) {
        urgentTimer = timers.setInterval(() => {
          urgentTick().catch((err) => log.error?.("ยามแจ้งด่วนทำงานไม่สำเร็จ:", err?.message ?? err));
        }, urgentMs);
        urgentTimer?.unref?.();
      }
      log.log?.(
        `⏰ รายงานเย็น ${at.label} น. (เวลาไทย) — รอบถัดไปอีก ${Math.round(waitMs / 60000)} นาที · ` +
          `ยามแจ้งด่วนทุก ${Math.round(urgentMs / 60000)} นาที`,
      );
      return { nextRunAt: when };
    },

    stop() {
      if (dailyTimer) timers.clearTimeout(dailyTimer);
      if (urgentTimer) timers.clearInterval(urgentTimer);
      dailyTimer = null;
      urgentTimer = null;
    },
  };
}
