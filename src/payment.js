/*
 * ช่องทางรับเงินของร้าน — อ่านจาก ENV เท่านั้น
 *
 * ═══ ทำไมต้อง ENV เท่านั้น ═══
 * เลขบัญชีกับพร้อมเพย์คือปลายทางของเงินจริง ถ้าหลุดขึ้น repo (repo นี้เป็น public)
 * หรือถูกใครแก้ผ่านแชทได้ เงินลูกค้าจะวิ่งไปผิดที่โดยที่ทุกฝ่ายเพิ่งรู้ตอนสาย
 * เอาคืนไม่ได้ด้วย ตรงนี้จึงตัดทางอื่นทิ้งหมด:
 *   - ไม่อ่านจาก context.md (อยู่ใน repo · สมองร้านก็อ่านไฟล์นั้น = แก้ได้ด้วยข้อความ)
 *   - ไม่อ่านจาก products.md · ไม่อ่านจาก cards/ · ไม่รับจากข้อความลูกค้า
 *   - ไม่มีค่าเริ่มต้นฝังในโค้ด — ไม่ตั้ง ENV = ไม่แจ้งช่องทางชำระเงินเลย ให้คนมาแจ้ง
 *
 * ═══ ไม่เอาเลขลง log / audit ═══
 * เลขบัญชีไม่ได้ลับระดับรหัสผ่าน (ลูกค้าต้องเห็นอยู่แล้วตอนโอน) แต่ log กับ audit
 * ถูกก๊อปไปแปะที่อื่นง่ายมาก และอยู่ยาวกว่าแชท จึงเก็บแค่ `id` ของช่องทางลงร่องรอย
 * ส่วนตัวเลขให้ไปโผล่บนการ์ดของลูกค้าคนนั้นอย่างเดียว (ดู auditRef)
 */

/* id ใช้เป็นคีย์ใน postback ด้วย — จำกัดอักขระให้ปลอดภัยกับ query string */
const ID_RE = /^[a-z0-9_-]{1,24}$/;

/* เลขบัญชี/พร้อมเพย์: ตัวเลข เว้นวรรค ขีด เท่านั้น — กันสตริงแปลก ๆ หลุดไปขึ้นการ์ด */
const NUMBER_RE = /^[\d][\d\s-]{6,24}$/;

export const TYPES = new Set(["promptpay", "bank"]);

/*
 * แปลงรายการเดียวให้เป็นรูปแบบมาตรฐาน — คืน null ถ้าใช้ไม่ได้
 * เหตุผลที่ไม่ throw: ตั้ง ENV ผิดไป 1 บรรทัดไม่ควรทำให้ร้านรับเงินไม่ได้ทั้งร้าน
 * ตัวที่ใช้ได้ยังใช้ต่อ ส่วนตัวที่พังขึ้น warning ให้เห็นตอนบูต (โดยไม่พ่นเลขออก log)
 */
function normalize(raw, index, fallbackName) {
  const id = String(raw?.id ?? "").trim().toLowerCase();
  const type = String(raw?.type ?? "").trim().toLowerCase();
  const number = String(raw?.number ?? "").trim();
  const label = String(raw?.label ?? "").trim();
  const accountName = String(raw?.account_name ?? fallbackName ?? "").trim();

  const why = [];
  if (!ID_RE.test(id)) why.push("id ต้องเป็น a-z 0-9 _ - ไม่เกิน 24 ตัว");
  if (!TYPES.has(type)) why.push(`type ต้องเป็น ${[...TYPES].join(" หรือ ")}`);
  if (!NUMBER_RE.test(number)) why.push("number ต้องเป็นตัวเลข (เว้นวรรค/ขีดได้) 7-25 ตัว");
  if (!label) why.push("ต้องมี label");
  if (!accountName) why.push("ต้องมี account_name หรือ PAYMENT_ACCOUNT_NAME");

  if (why.length > 0) {
    /* จงใจอ้างถึงรายการด้วย "ลำดับที่" ไม่ใช่เลขบัญชี — ข้อความนี้ไปอยู่ใน log */
    console.warn(`⚠️  ช่องทางรับเงินลำดับที่ ${index + 1} ใช้ไม่ได้: ${why.join(" · ")}`);
    return null;
  }

  return { id, type, label, number, account_name: accountName };
}

/*
 * คืนรายการช่องทางรับเงินทั้งหมด — [] ถ้าไม่ได้ตั้ง ENV ไว้
 *
 * รูปแบบ PAYMENT_DESTINATIONS_JSON:
 *   [{"id":"pp","type":"promptpay","label":"พร้อมเพย์","number":"0XX-XXX-XXXX"},
 *    {"id":"kbank","type":"bank","label":"กสิกรไทย","number":"XXX-X-XXXXX-X"}]
 *
 * ถ้ายังไม่ได้ตั้ง แต่มี PROMPTPAY_ID เดิมอยู่ จะถือว่าเป็นช่องทางเดียวชนิดพร้อมเพย์
 * (ของเดิมที่ deploy ไปแล้วจะได้ไม่ดับตอนอัปเดต)
 */
export function paymentDestinations({ env = process.env } = {}) {
  const fallbackName = String(env.PAYMENT_ACCOUNT_NAME ?? "").trim();
  const raw = String(env.PAYMENT_DESTINATIONS_JSON ?? "").trim();

  if (!raw) {
    if (!env.PROMPTPAY_ID) return [];
    const single = normalize(
      { id: "promptpay", type: "promptpay", label: "พร้อมเพย์", number: env.PROMPTPAY_ID },
      0,
      fallbackName,
    );
    return single ? [single] : [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* ห้าม log ตัว raw ออกมา — ข้างในมีเลขบัญชี */
    console.warn("⚠️  PAYMENT_DESTINATIONS_JSON ไม่ใช่ JSON ที่อ่านได้ — ถือว่ายังไม่ได้ตั้งช่องทางรับเงิน");
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn("⚠️  PAYMENT_DESTINATIONS_JSON ต้องเป็น array ของช่องทางรับเงิน");
    return [];
  }

  const list = parsed.map((d, i) => normalize(d, i, fallbackName)).filter(Boolean);

  /* id ซ้ำกันแปลว่า postback จะชี้ไปคนละที่กับที่ลูกค้าเห็นบนการ์ด — ตัดตัวหลังทิ้ง */
  const seen = new Set();
  return list.filter((d) => {
    if (seen.has(d.id)) {
      console.warn(`⚠️  ช่องทางรับเงิน id "${d.id}" ซ้ำ — ใช้ตัวแรกตัวเดียว`);
      return false;
    }
    seen.add(d.id);
    return true;
  });
}

/* หาช่องทางตาม id ที่ติดมากับ postback — null ถ้าไม่มี (ห้ามเดาเป็นตัวแรก) */
export const destinationById = (id, list = paymentDestinations()) =>
  list.find((d) => d.id === String(id ?? "").trim().toLowerCase()) ?? null;

/* ช่องทางที่ออก QR ได้ — ตอนนี้มีแต่พร้อมเพย์ (ชนิด bank โอนด้วยเลขบัญชีอย่างเดียว) */
export const qrDestinations = (list = paymentDestinations()) => list.filter((d) => d.type === "promptpay");

/*
 * ตัวอ้างอิงที่เอาลง audit / log ได้ — มีแต่ id กับชนิด ไม่มีตัวเลข
 * ใช้ทุกที่ที่ต้องบันทึกว่า "ออก QR ของช่องทางไหน" โดยไม่ทิ้งเลขบัญชีไว้ในไฟล์
 */
export const auditRef = (destination) =>
  destination ? { dest_id: destination.id, dest_type: destination.type } : { dest_id: null, dest_type: null };
