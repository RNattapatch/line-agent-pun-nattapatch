/*
 * ตัวจำลองความพัง — สำหรับ Customer Test เท่านั้น
 *
 * ═══ ทำไมต้องมี ═══
 * เกราะสนทนามีค่าก็ต่อเมื่อพิสูจน์ได้ว่ามันทำงานจริงตอนของพัง
 * แต่ของพวกนี้ (LINE ล่ม · โมเดลล่ม · timeout · token หมดอายุ · อ่านสมองร้านไม่ได้)
 * รอให้เกิดเองไม่ได้ และไม่มีใครอยากให้เกิดตอนมีลูกค้าจริงอยู่ในห้อง
 *
 * ═══ ทำไมต้องกันไว้หลายชั้น ═══
 * สวิตช์ที่ทำให้ระบบพังได้ตามสั่ง คือสวิตช์ที่ถ้าค้างอยู่จะทำให้ร้านเสียลูกค้าจริง
 *   1. ต้องตั้ง ALLOW_FAULT_INJECTION=1 ก่อน ไม่ตั้ง = เปิดไม่ได้เลย
 *   2. เปิดได้ทีละแบบเท่านั้น
 *   3. หมดอายุเองใน 5 นาที ต่อให้ลืมปิด
 *   4. มีแอดมิน claim อยู่แล้ว (ร้านเปิดใช้งานจริง) = เปิดไม่ได้
 *
 * ข้อ 4 สำคัญสุด: Customer Test คือช่วงที่ยังไม่มีใครถือสิทธิ์แอดมิน
 * พอ claim แล้วแปลว่าเข้าโหมดใช้งานจริง สวิตช์นี้ต้องปิดตายทันที
 */

/* 5 แบบตามโจทย์ */
export const FAULTS = {
  line_api: "ส่งข้อความผ่าน LINE ไม่ได้",
  model: "สมองร้านล่ม",
  timeout: "ปลายทางค้างจนหมดเวลา",
  reply_token: "reply token หมดอายุ",
  brain: "อ่านไฟล์สมองร้านไม่ได้",
};

export const isFault = (id) => Object.hasOwn(FAULTS, String(id));

/* เปิดได้นานสุด 5 นาที แล้วดับเอง */
export const FAULT_TTL_MS = 5 * 60 * 1000;

export function createFaultBox({
  claims,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  let active = null; // { fault, until }

  const allowed = () => String(env.ALLOW_FAULT_INJECTION ?? "") === "1";

  const live = () => {
    if (!active) return null;
    if (now() >= active.until) {
      active = null;
      return null;
    }
    return active;
  };

  return {
    FAULTS,

    /* เปิด 1 แบบ — คืน { ok, reason } เสมอ ไม่โยน error */
    enable(fault) {
      if (!allowed()) return { ok: false, reason: "ไม่ได้ตั้ง ALLOW_FAULT_INJECTION=1 — เปิดไม่ได้" };
      if (!isFault(fault)) return { ok: false, reason: `ไม่รู้จัก fault "${fault}"` };
      if (claims?.currentAdmin()) {
        return { ok: false, reason: "มีแอดมิน claim สิทธิ์อยู่แล้ว (โหมดใช้งานจริง) — เปิดไม่ได้" };
      }
      active = { fault, until: now() + FAULT_TTL_MS };
      return { ok: true, fault, until: active.until, ttlMs: FAULT_TTL_MS };
    },

    disable() {
      const had = live()?.fault ?? null;
      active = null;
      return { ok: true, had };
    },

    /* fault นี้กำลังเปิดอยู่ไหม — ตัวเรียกใช้ตรวจก่อนทำงานจริง */
    active(fault) {
      const cur = live();
      if (!cur) return false;
      /* claim ระหว่างที่เปิดค้างอยู่ก็ต้องดับทันที ไม่ต้องรอหมดเวลา */
      if (claims?.currentAdmin()) {
        active = null;
        return false;
      }
      return cur.fault === fault;
    },

    status() {
      const cur = live();
      return {
        allowed: allowed(),
        blockedByAdmin: Boolean(claims?.currentAdmin()),
        active: cur?.fault ?? null,
        secondsLeft: cur ? Math.max(0, Math.round((cur.until - now()) / 1000)) : 0,
      };
    },
  };
}
