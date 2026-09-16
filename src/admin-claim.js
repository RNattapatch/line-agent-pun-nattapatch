/*
 * Claim Admin — ยกสิทธิ์ผู้ดูแลให้ LINE user คนหนึ่ง ด้วยรหัสใช้ครั้งเดียว
 *
 * ═══ ทำไมไม่ใช้ ADMIN_USER_ID ใน .env ═══
 * การจะรู้ LINE userId ของตัวเองต้องไปขุดจาก log หรือจากไฟล์ใบเสนอราคา ซึ่งแปลว่า
 * ต้องเอา userId (ข้อมูลส่วนบุคคล) มาวางไว้ในไฟล์ตั้งค่าและใน history ของ shell
 * และเวลาจะเปลี่ยนตัวแอดมินต้องแก้ไฟล์แล้ว recreate container ทุกครั้ง
 *
 * วิธีนี้กลับด้าน: เจ้าของร้านสั่งเครื่องมือผู้ดูแลให้ "ออกรหัส" แล้วเอารหัสไปพิมพ์ในแชท
 * ระบบจึงรู้เองว่า userId ไหนคือแอดมิน โดยไม่มีใครต้องพิมพ์ userId หรือตั้งวลีเอง
 *
 * ═══ รหัสเก็บเป็น hash เท่านั้น ═══
 * ไฟล์ state เก็บแค่ sha256 ของรหัส ตัวรหัสจริงมีชีวิตอยู่ 2 ที่เท่านั้น:
 * บนหน้าจอตอนเครื่องมือพิมพ์ออกมาครั้งเดียว กับในหัวของคนที่กำลังจะพิมพ์ลงแชท
 * ใครอ่านไฟล์นี้ได้ก็ยังเอาไป claim ไม่ได้ และไม่มีอะไรให้หลุดขึ้น repo
 *
 * ═══ รหัสห้ามผ่าน argv ═══
 * เครื่องมือ "สร้าง" รหัสเอง ไม่ใช่รับจากคนพิมพ์ — รหัสจึงไม่เคยอยู่ใน argv
 * ของ process ไหนเลย (ps aux ของ user อื่นบนเครื่องเดียวกันอ่าน argv ได้)
 * และไม่เคยอยู่ใน history ของ shell ด้วย
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/* อายุรหัส 15 นาที — สั้นพอให้รหัสที่ลืมไว้บนจอหมดฤทธิ์เอง */
export const TTL_MINUTES = 15;

/* RFC 4648 base32 — ไม่มี 0/1/8 ที่สับสนกับ O/I/B ตอนอ่านจากจอไปพิมพ์ในมือถือ */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/* 160 บิต = 20 ไบต์ = 32 ตัวอักษรพอดี ไม่มีเศษ จึงไม่ต้องมี padding "=" */
export const CODE_BYTES = 20;
export const CODE_LENGTH = 32;

/* รูปแบบรหัสที่ยอมรับ — ใช้ทั้งตอนตรวจและตอนดักข้อความในแชท */
export const CODE_RE = new RegExp(`^[A-Z2-7]{${CODE_LENGTH}}$`);

export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/*
 * ลูกค้าพิมพ์รหัสจากมือถือ จะมีเว้นวรรค ขีด หรือพิมพ์เล็กปนมาเป็นเรื่องปกติ
 * ปรับให้เป็นรูปแบบเดียวก่อนเทียบ — ไม่งั้นรหัสที่ถูกต้องจะถูกปฏิเสธเพราะเว้นวรรคเกิน
 */
export const normalizeCode = (input) => String(input ?? "").replace(/[\s-]/g, "").toUpperCase();

/* ข้อความนี้หน้าตาเหมือนรหัส claim ไหม — ใช้ดักก่อนข้อความเข้าท่อปกติ */
export function looksLikeCode(text) {
  const bare = normalizeCode(text);
  if (CODE_RE.test(bare)) return bare;

  /* เผื่อคนพิมพ์คำนำหน้ามาด้วย เช่น "claim XXXX" — ตัดคำหน้าออกแล้วลองอีกที */
  const m = String(text ?? "").trim().match(/^(?:claim|claim-admin|ยืนยันสิทธิ์)\s+(.+)$/i);
  if (m) {
    const inner = normalizeCode(m[1]);
    if (CODE_RE.test(inner)) return inner;
  }
  return null;
}

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/*
 * เทียบ hash แบบใช้เวลาคงที่
 * การเทียบสตริงด้วย === จะหยุดทันทีที่เจอตัวอักษรต่างตัวแรก เวลาที่ใช้จึงบอกได้ว่า
 * เดาถูกไปกี่ตัว ซึ่งพอจะไล่เดาทีละตัวได้ ถึงจะยากมากในทางปฏิบัติแต่ก็ไม่มีเหตุให้เปิดช่องไว้
 */
function sameHash(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export const adminDir = () =>
  process.env.SHOP_DATA_DIR
    ? path.join(process.env.SHOP_DATA_DIR, "admin")
    : path.join(os.homedir(), "shop-data", "admin");

const EMPTY = { admin: null, pending: null, history: [] };

/* ผลของการ claim — ผู้เรียกแปลเป็นข้อความเอง (ข้อความลูกค้ากับข้อความ log ไม่เหมือนกัน) */
export const CLAIM = {
  OK: "ok",
  NO_CODE: "no-code",
  INVALID: "invalid",
  EXPIRED: "expired",
  REPLAY: "replay",
};

export function createAdminClaims({ dir = adminDir(), now = () => new Date() } = {}) {
  const file = path.join(dir, "state.json");

  function ensure() {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    return dir;
  }

  /*
   * อ่านใหม่จากดิสก์ทุกครั้ง ไม่แคชไว้ในหน่วยความจำ
   * เพราะเครื่องมือผู้ดูแล (คนละ process กับเซิร์ฟเวอร์) เป็นคนออกรหัสและสั่ง revoke
   * ถ้าเซิร์ฟเวอร์แคชไว้ จะยัง "เชื่อ" ว่าคนที่เพิ่งโดน revoke ยังเป็นแอดมินอยู่จนกว่าจะรีสตาร์ต
   * ไฟล์เล็กมากและถูกอ่านเฉพาะตอนมีข้อความเข้า จึงไม่คุ้มที่จะแลกความถูกต้องกับความเร็วตรงนี้
   */
  function read() {
    try {
      return { ...EMPTY, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { ...EMPTY };
    }
  }

  function write(state) {
    ensure();
    const tmp = path.join(dir, `.state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, file);
    return state;
  }

  /* ร่องรอยเก็บแค่ "เกิดอะไรขึ้น" — ไม่มีรหัส ไม่มี userId เต็ม มีแค่ 4 ตัวท้าย */
  const log = (state, event, detail = {}) => {
    state.history.push({ at: now().toISOString(), event, ...detail });
    if (state.history.length > 200) state.history = state.history.slice(-200);
    return state;
  };

  const suffix = (id) => String(id ?? "").slice(-4) || "????";

  return {
    dir,
    ensure,
    read,

    /*
     * ออกรหัสใหม่ — คืนรหัสตัวจริงกลับไปครั้งเดียวให้ผู้เรียกพิมพ์ออกจอ
     * ไม่เขียนรหัสลงไฟล์ ไม่ส่งเข้า console เอง ผู้เรียกเป็นคนตัดสินใจว่าจะแสดงยังไง
     *
     * ออกรหัสใหม่ = รหัสเก่าตายทันที (pending มีได้ทีละใบเดียว)
     * ถ้าเก็บได้หลายใบพร้อมกัน รหัสที่ออกไว้แล้วลืมยกเลิกจะยังใช้ได้อยู่โดยไม่มีใครรู้
     */
    issue() {
      const code = base32(crypto.randomBytes(CODE_BYTES));
      const state = read();
      const at = now();

      if (state.pending && !state.pending.used_at) {
        log(state, "code-superseded", { code_id: state.pending.id });
      }

      state.pending = {
        id: crypto.randomUUID(),
        algo: "sha256",
        hash: sha256(code),
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + TTL_MINUTES * 60 * 1000).toISOString(),
        used_at: null,
      };
      log(state, "code-issued", { code_id: state.pending.id, ttl_minutes: TTL_MINUTES });
      write(state);

      return { code, id: state.pending.id, expiresAt: state.pending.expires_at };
    },

    /*
     * ลอง claim ด้วยรหัสที่ลูกค้าพิมพ์มา — คืน { result, admin }
     *
     * ลำดับการตรวจสำคัญ: ต้องเทียบ hash ก่อน แล้วค่อยดูว่าหมดอายุ/ใช้ไปแล้วหรือยัง
     * ถ้าสลับกัน คนที่เดารหัสมั่วจะแยกออกว่า "รหัสนี้มีอยู่จริงแต่หมดอายุ" กับ "ไม่มีรหัสนี้"
     * ซึ่งบอกเขาว่าเดาถูกแล้ว
     */
    claim(rawCode, lineUserId) {
      const code = normalizeCode(rawCode);
      if (!CODE_RE.test(code)) return { result: CLAIM.INVALID };

      const state = read();
      const pending = state.pending;
      if (!pending) return { result: CLAIM.INVALID };
      if (!sameHash(pending.hash, sha256(code))) return { result: CLAIM.INVALID };

      if (pending.used_at) {
        log(state, "claim-replay", { code_id: pending.id, user_suffix: suffix(lineUserId) });
        write(state);
        return { result: CLAIM.REPLAY };
      }

      if (new Date(pending.expires_at).getTime() <= now().getTime()) {
        log(state, "claim-expired", { code_id: pending.id, user_suffix: suffix(lineUserId) });
        write(state);
        return { result: CLAIM.EXPIRED };
      }

      if (!lineUserId) return { result: CLAIM.INVALID };

      pending.used_at = now().toISOString();
      const previous = state.admin?.line_user_id ?? null;
      state.admin = {
        line_user_id: lineUserId,
        claimed_at: now().toISOString(),
        code_id: pending.id,
      };
      log(state, "claimed", {
        code_id: pending.id,
        user_suffix: suffix(lineUserId),
        ...(previous ? { replaced_suffix: suffix(previous) } : {}),
      });
      write(state);

      return { result: CLAIM.OK, admin: state.admin, replaced: previous };
    },

    /*
     * ถอนสิทธิ์ — สั่งได้จากเครื่องมือผู้ดูแลเท่านั้น ไม่มีคำสั่งในแชท
     * ถ้าสั่ง revoke จากแชทได้ คนที่ยึดบัญชีแอดมินไปจะ revoke ตัวเองทิ้งเพื่อลบร่องรอยได้
     * และถ้า revoke ตัวเองพลาด เจ้าของร้านจะไม่เหลือทางกลับเข้ามาเลยนอกจาก SSH อยู่ดี
     *
     * รหัสที่ยังค้างอยู่ก็ตายไปพร้อมกัน — ไม่งั้น revoke แล้วยังมีรหัสเก่าลอยอยู่ให้ claim กลับ
     */
    revoke({ actor = "operator" } = {}) {
      const state = read();
      const had = state.admin;
      state.admin = null;
      if (state.pending && !state.pending.used_at) state.pending.used_at = now().toISOString();
      log(state, "revoked", { actor, ...(had ? { user_suffix: suffix(had.line_user_id) } : {}) });
      write(state);
      return { ok: true, had: Boolean(had) };
    },

    /* LINE userId ของแอดมินตอนนี้ — null ถ้ายังไม่มีใคร claim */
    currentAdmin() {
      return read().admin?.line_user_id ?? null;
    },

    isAdmin(lineUserId) {
      if (!lineUserId) return false;
      return read().admin?.line_user_id === lineUserId;
    },

    /* สรุปสถานะให้เครื่องมือผู้ดูแลแสดง — ไม่มีรหัส ไม่มี userId เต็ม */
    status() {
      const state = read();
      const pending = state.pending;
      const live = pending && !pending.used_at && new Date(pending.expires_at).getTime() > now().getTime();
      return {
        hasAdmin: Boolean(state.admin),
        adminSuffix: state.admin ? suffix(state.admin.line_user_id) : null,
        claimedAt: state.admin?.claimed_at ?? null,
        pendingCode: live
          ? { expiresAt: pending.expires_at, secondsLeft: Math.max(0, Math.round((new Date(pending.expires_at) - now()) / 1000)) }
          : null,
        history: state.history.slice(-10),
      };
    },
  };
}

/* ตัวกลางที่เซิร์ฟเวอร์ใช้ — เทสต์สร้างของตัวเองชี้ไป temp dir */
export const adminClaims = createAdminClaims();
