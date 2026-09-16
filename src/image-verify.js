/*
 * ด่านตรวจรูปก่อนขึ้นการ์ด — "ลิงก์ถาวร + ตอบ 200" เท่านั้นถึงจะส่งให้ลูกค้าได้
 *
 * ทำไมต้องตรวจ: การ์ด Flex ที่รูปโหลดไม่ขึ้นจะแสดงเป็นกรอบเทาว่าง ๆ ในแชทลูกค้า
 * ดูเหมือนร้านทำงานไม่เรียบร้อย และลูกค้าไม่มีทางรู้ว่าต้องกดอะไรต่อ
 * เดิมเรื่องนี้ไม่เคยพังเพราะส่ง message ชนิด image แล้ว LINE โหลดไม่ได้จะไม่ส่งให้เลย
 * แต่การ์ด Flex ส่งสำเร็จเสมอแม้รูปพัง — ความผิดพลาดเลยเงียบกว่าเดิม ต้องดักเอง
 *
 * "ถาวร" นิยามแบบตัดทิ้งชัด ๆ: https เท่านั้น และต้องไม่ใช่โฮสต์ที่รู้กันว่าอายุสั้น
 * (kie.ai คืน URL บนโดเมน tempfile.* ที่หมดอายุ ~24 ชม. — ห้ามเอามาแปะการ์ดเด็ดขาด
 *  รูปทุกใบต้องถูกโหลดมาเก็บใน public/images ก่อน ดู scripts/gen-images.mjs)
 */

/* โฮสต์ที่ห้ามใช้เป็นรูปการ์ด — ของชั่วคราวทั้งนั้น */
const TEMPORARY_HOSTS = [
  /(^|\.)tempfile\./i,
  /(^|\.)ngrok(-free)?\.(io|app|dev)$/i,
  /(^|\.)trycloudflare\.com$/i,
  /(^|\.)loca\.lt$/i,
  /(^|\.)serveo\.net$/i,
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
];

/* นานแค่ไหนถึงตรวจซ้ำ — รูปอยู่บนที่เก็บถาวรอยู่แล้ว ตรวจบ่อยก็เปลืองเปล่า */
export const VERIFY_TTL_MS = 6 * 60 * 60 * 1000;

const VERIFY_TIMEOUT_MS = 8_000;

export function isPermanentUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false; // LINE บังคับ TLS อยู่แล้ว และ http ไม่มีทางถาวรจริง
  return !TEMPORARY_HOSTS.some((re) => re.test(u.hostname));
}

/*
 * แคชผลตรวจ — key คือ URL เต็ม
 * เก็บทั้งผลผ่านและไม่ผ่าน เพื่อไม่ให้รูปที่พังอยู่โดนยิงซ้ำทุกนาทีตามจังหวะตัวส่งการ์ด
 */
const results = new Map();

export function clearVerifyCache() {
  results.clear();
}

/*
 * ตรวจว่า URL ใช้ได้จริง — คืน true/false
 * ไม่ผ่านทุกกรณีที่ไม่ชัวร์: ไม่ใช่ลิงก์ถาวร / ไม่ใช่ 200 / ไม่ใช่รูป / เน็ตล่ม / ช้าเกิน
 * ผู้เรียกต้องตกไปใช้ข้อความสำรอง ไม่ใช่ส่งการ์ดรูปพัง
 */
export async function verifyImageUrl(url, { fetchImpl = fetch, now = () => Date.now(), ttlMs = VERIFY_TTL_MS } = {}) {
  if (!isPermanentUrl(url)) return false;

  const hit = results.get(url);
  if (hit && now() - hit.at < ttlMs) return hit.ok;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let ok = false;

  try {
    /*
     * HEAD ก่อนเพราะไม่ต้องโหลดตัวรูป (บางใบเกือบ 1 MB)
     * GitHub raw รับ HEAD ปกติ แต่ CDN บางเจ้าตอบ 405 — เจอแบบนั้นค่อยถอยไป GET
     */
    let res = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    ok = res.status === 200 && /^image\//i.test(res.headers?.get?.("content-type") ?? "");
  } catch {
    ok = false; // เน็ตล่ม / timeout — ถือว่าใช้ไม่ได้ไว้ก่อน ปลอดภัยกว่าส่งการ์ดเสี่ยง
  } finally {
    clearTimeout(timer);
  }

  results.set(url, { ok, at: now() });
  return ok;
}
