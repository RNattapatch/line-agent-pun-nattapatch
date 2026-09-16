/*
 * ตัวส่งรายงานถึงเจ้าของร้าน — 4 งานที่ต้องถึงมือแอดมินเสมอ
 *
 * ═══ ก่อนมีแอดมิน ห้ามยิงเข้าห้องไหนทั้งนั้น ═══
 * ตอนที่ยังไม่มีใคร claim สิทธิ์ ระบบ "ไม่รู้" ว่าห้องไหนเป็นห้องเจ้าของร้าน
 * ห้องที่ดูเหมือนห้องเจ้าของอาจเป็นห้องที่เจ้าของกำลังทดสอบตัวเองเป็นลูกค้าอยู่ก็ได้
 * ยิงรายงานยอดขายเข้าไปตรงนั้นคือยิงข้อมูลภายในใส่สิ่งที่อาจเป็นบทสนทนาลูกค้า
 *
 * ตอนนั้นจึงเป็น deliver=local: เขียนลงคิวบนดิสก์ + ขึ้น log ฝั่งเซิร์ฟเวอร์ จบ
 *
 * ═══ ของที่ค้างไว้ต้องไม่หาย ═══
 * พอมีคน claim สำเร็จ ของในคิวทั้งหมดต้องไหลเข้าแอดมินตามลำดับเดิมให้ครบ
 * รายงานที่หายไปเงียบ ๆ คือรายงานที่ไม่มีใครรู้ว่าเคยมี — แย่กว่ารายงานที่มาช้า
 *
 * ด้วยเหตุผลเดียวกัน ถ้า push ไม่สำเร็จ (LINE ล่ม / โควตาหมด) ของชิ้นนั้นต้องกลับเข้าคิว
 * ไม่ใช่หายไปพร้อม error ใน log
 */

import fs from "node:fs";
import path from "node:path";

import { adminClaims, adminDir } from "./admin-claim.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/* 4 งานที่โจทย์กำหนด — ระบบจริงของแต่ละงานสร้างใน MP-08 ตรงนี้คือเส้นทางส่ง */
export const REPORT_JOBS = {
  evening: { id: "evening", label: "รายงานเย็น", icon: "🌆" },
  urgent: { id: "urgent", label: "แจ้งด่วน", icon: "🔔" },
  slip: { id: "slip", label: "แจ้งสลิป", icon: "💸" },
  appointment: { id: "appointment", label: "แจ้งนัดใหม่", icon: "📅" },
};

export const isReportJob = (id) => Object.hasOwn(REPORT_JOBS, String(id));

/* คิวเก็บได้กี่ชิ้นก่อนตัดของเก่าทิ้ง — กันดิสก์เต็มถ้าไม่มีใคร claim นาน ๆ */
const MAX_SPOOL = 500;

export function createReports({
  dir = adminDir(),
  claims = adminClaims,
  push,
  now = () => new Date(),
  log = console,
} = {}) {
  const spoolFile = path.join(dir, "spool.jsonl");

  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
  };

  function readSpool() {
    try {
      return fs
        .readFileSync(spoolFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function writeSpool(items) {
    ensure();
    const keep = items.slice(-MAX_SPOOL);
    const tmp = path.join(dir, `.spool.${process.pid}.tmp`);
    fs.writeFileSync(tmp, keep.map((i) => JSON.stringify(i)).join("\n") + (keep.length ? "\n" : ""), {
      mode: FILE_MODE,
    });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, spoolFile);
    return keep.length;
  }

  const spool = (item) => {
    const items = readSpool();
    items.push(item);
    const dropped = items.length - MAX_SPOOL;
    if (dropped > 0) log.warn?.(`⚠️  คิวรายงานเต็ม ตัดของเก่าทิ้ง ${dropped} ชิ้น`);
    writeSpool(items);
  };

  /* ข้อความที่แอดมินเห็นจริง — มีหัวข้อบอกว่าเป็นงานไหน และเวลาที่เกิดเรื่อง */
  const compose = (item) => {
    const job = REPORT_JOBS[item.job];
    const when = new Date(item.at);
    const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    const late = item.spooled ? " (ค้างคิวไว้ตอนยังไม่มีแอดมิน)" : "";
    return { type: "text", text: `${job.icon} ${job.label} ${clock} น.${late}\n${item.text}` };
  };

  async function deliver(item) {
    const to = claims.currentAdmin();
    if (!to) return false;
    try {
      await push({ to, messages: [compose(item)] });
      return true;
    } catch (err) {
      log.error?.(`ส่ง${REPORT_JOBS[item.job].label}ให้แอดมินไม่สำเร็จ:`, err?.message ?? err);
      return false;
    }
  }

  return {
    dir,
    spoolSize: () => readSpool().length,

    /* ตอนนี้รายงานไปไหน — "admin" เมื่อมีคน claim แล้ว ไม่งั้น "local" */
    deliverMode: () => (claims.currentAdmin() ? "admin" : "local"),

    /*
     * ส่ง 1 รายงาน — คืน "admin" ถ้าถึงมือแอดมินจริง, "local" ถ้าเก็บเข้าคิวไว้ก่อน
     * ไม่เคยคืนว่า "หาย" เพราะทุกเส้นทางที่ส่งไม่ได้จบลงที่คิวเสมอ
     */
    async submit(jobId, text) {
      if (!isReportJob(jobId)) throw new TypeError(`ไม่รู้จักงานรายงาน "${jobId}"`);
      const item = { at: now().toISOString(), job: jobId, text: String(text ?? "") };

      if (!claims.currentAdmin()) {
        spool({ ...item, spooled: true });
        log.log?.(`📥 [local] ${REPORT_JOBS[jobId].label} — เก็บเข้าคิวไว้ก่อน ยังไม่มีแอดมิน`);
        return "local";
      }

      if (await deliver(item)) return "admin";

      /* ส่งไม่ผ่านต้องกลับเข้าคิว ไม่ใช่หายไปพร้อม error */
      spool({ ...item, spooled: true });
      return "local";
    },

    /*
     * เทของในคิวให้แอดมินตามลำดับเดิม — เรียกทันทีหลัง claim สำเร็จ
     * ชิ้นไหนส่งไม่ผ่านให้หยุดตรงนั้นแล้วเก็บที่เหลือไว้ในคิวต่อ ไม่ข้ามไปส่งชิ้นถัดไป
     * เพราะรายงานเรียงตามเวลา ส่งสลับลำดับแล้วคนอ่านจะปะติดปะต่อเรื่องผิด
     */
    async flush() {
      if (!claims.currentAdmin()) return { sent: 0, left: readSpool().length };

      const items = readSpool();
      let sent = 0;
      for (const item of items) {
        if (!(await deliver(item))) break;
        sent++;
      }

      const left = items.slice(sent);
      writeSpool(left);
      if (sent > 0) log.log?.(`📤 ส่งรายงานที่ค้างคิว ${sent} ชิ้นให้แอดมินแล้ว`);
      return { sent, left: left.length };
    },
  };
}
