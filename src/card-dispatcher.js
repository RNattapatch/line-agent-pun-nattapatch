/*
 * ตัวส่งการ์ด — ตื่นทุก 1 นาที หยิบ intent ที่คิวไว้ แล้วส่งการ์ดที่ตรงรุ่น
 *
 * ทำไมต้องแยกเป็นตัวตื่นทุกนาที แทนที่จะส่งการ์ดตอบไปเลยในจังหวะเดียวกับข้อความ:
 *   - ลูกค้าพิมพ์ทีละบับเบิลแล้วเปลี่ยนใจกลางคัน ("สนใจบราวนี่" → "อ๋อ เอาชิโอะปังดีกว่า")
 *     ถ้าส่งการ์ดทันทีจะได้การ์ดผิดรุ่นค้างอยู่ในแชท พักไว้ก่อนแล้วดูสถานะล่าสุดค่อยส่ง
 *   - จังหวะชำระเงินเปลี่ยนได้ระหว่างที่รอ (ลูกค้าส่งสลิปตามมา) ตัวส่งการ์ดเช็คใหม่ตอนจะส่งจริง
 *     ไม่ใช่ตอนที่คิว ทำให้การ์ดไม่หลุดตามหลังสลิป
 *
 * ═══ กติกาเงียบ (ห้ามส่งการ์ดสินค้าเด็ดขาด) ═══
 *   ก. event ล่าสุดของลูกค้าเป็นรูปภาพ  → รูปสลิปไม่ใช่ความสนใจสินค้า
 *   ข. ข้อความมีคำจำพวก โอนแล้ว/สลิป/ชำระ/จ่ายแล้ว
 *   ค. ลูกค้ามี quote สถานะ "ส่งลูกค้า" หรือ "รับสลิปแล้ว" ค้างอยู่
 * ทั้งสามข้อคือ "ร้านกำลังรอเงิน" การยิงการ์ดขายของตามหลังทำให้ลูกค้าไม่แน่ใจว่า
 * ร้านได้รับเงินหรือยัง และดูเหมือนร้านพยายามขายเพิ่มทั้งที่ยอดเดิมยังไม่ปิด
 *
 * ═══ กันส่งซ้ำรายวัน ═══
 * key เป็น chatId + slug + วันที่ ลูกค้าถามบราวนี่กล่อง 5 รอบในวันเดียวได้การ์ดใบเดียว
 * ตัวตอบ (src/reply.js) ที่ส่งการ์ดทันทีก็ต้องมาปั๊ม markSent() ด้วย
 * ไม่งั้นลูกค้าจะได้การ์ดใบที่สองตามมาอีกภายในนาที
 */

export const TICK_MS = 60_000;

const dayKey = (date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

/*
 * send({ chatId, slug })  — ส่งการ์ดจริง คืน true ถ้าส่งสำเร็จ
 * muted({ chatId })       — ตอนนี้ห้ามส่งการ์ดให้ห้องนี้ไหม
 */
export function createCardDispatcher({
  send,
  muted = () => false,
  tickMs = TICK_MS,
  now = () => new Date(),
  timers = { setInterval, clearInterval },
} = {}) {
  if (typeof send !== "function") throw new TypeError("createCardDispatcher ต้องมี send");

  /* chatId -> { slug, queuedAt, reason } — 1 ห้องคิวได้ทีละใบ ของใหม่ทับของเก่า
   * (ลูกค้าเปลี่ยนใจแล้วต้องได้รุ่นที่พูดล่าสุด ไม่ใช่ได้ทั้งสองใบ) */
  const queue = new Map();

  /* "chatId|slug|YYYYMMDD" -> เวลาที่ส่ง ของการ์ดที่ส่งไปแล้ววันนี้ */
  const sent = new Map();
  let sentDay = dayKey(now());

  const rollDay = () => {
    const today = dayKey(now());
    if (today !== sentDay) {
      sent.clear(); // ขึ้นวันใหม่ = ส่งการ์ดรุ่นเดิมซ้ำได้ ไม่ต้องเก็บของเมื่อวานให้เปลืองแรม
      sentDay = today;
    }
  };

  const keyOf = (chatId, slug) => `${chatId}|${slug}|${dayKey(now())}`;

  let handle = null;

  const api = {
    /* จองไว้ว่าจะส่งการ์ดรุ่นนี้ให้ห้องนี้ — ยังไม่ส่งจนกว่าจะถึงรอบ */
    queue(chatId, slug, { reason = "intent" } = {}) {
      if (!chatId || !slug) return false;
      rollDay();
      if (sent.has(keyOf(chatId, slug))) return false; // ส่งไปแล้ววันนี้
      queue.set(chatId, { slug, reason, queuedAt: now().getTime() });
      return true;
    },

    /* ตัวตอบส่งการ์ดเองแล้ว มาปั๊มไว้กันตัวส่งการ์ดยิงซ้ำ */
    markSent(chatId, slug) {
      rollDay();
      sent.set(keyOf(chatId, slug), now().getTime());
      const pending = queue.get(chatId);
      if (pending?.slug === slug) queue.delete(chatId);
    },

    alreadySent(chatId, slug) {
      rollDay();
      return sent.has(keyOf(chatId, slug));
    },

    /*
     * การ์ดใบนี้เพิ่งส่งไปเมื่อกี้หรือเปล่า — ใช้ปิดช่องโหว่จังหวะชนกัน
     * ลูกค้าถามราคา (คิวการ์ดไว้) → ตัวส่งการ์ดตื่นพอดีแล้วส่งไป → ลูกค้าถามต่อ "มีรูปไหม"
     * ถ้าไม่เช็ค ลูกค้าจะได้การ์ดรุ่นเดียวกันสองใบติดกันภายในไม่กี่วินาที
     * ต่างจาก alreadySent ตรงที่ "เมื่อเช้าเคยส่ง" ไม่นับ — ลูกค้าเลื่อนหาไม่เจอแล้ว ส่งใหม่ถูกต้องกว่า
     */
    sentRecently(chatId, slug, withinMs = 10 * 60 * 1000) {
      rollDay();
      const at = sent.get(keyOf(chatId, slug));
      return at !== undefined && now().getTime() - at < withinMs;
    },

    /* ล้างคิวของห้องนี้ทิ้ง — ใช้ตอนลูกค้าเข้าโหมดชำระเงินระหว่างที่การ์ดยังค้างคิว */
    drop(chatId) {
      return queue.delete(chatId);
    },

    /* 1 รอบ — คืนสรุปไว้ดูตอนเทสต์และตอนอ่าน log */
    async tick() {
      rollDay();
      const jobs = [...queue.entries()];
      queue.clear();

      const result = { sent: [], muted: [], skipped: [], failed: [] };

      for (const [chatId, job] of jobs) {
        const key = keyOf(chatId, job.slug);
        if (sent.has(key)) {
          result.skipped.push(chatId);
          continue;
        }

        /* เช็คตอนจะส่งจริง ไม่ใช่ตอนคิว — สถานะอาจเปลี่ยนไปแล้วระหว่างรอ */
        let isMuted = false;
        try {
          isMuted = await muted({ chatId, slug: job.slug });
        } catch (err) {
          // อ่านสถานะไม่ได้ = ไม่รู้ว่าอยู่ในจังหวะชำระเงินหรือเปล่า → เงียบไว้ก่อน
          console.warn("เช็คบริบทชำระเงินไม่สำเร็จ:", err?.message ?? err);
          isMuted = true;
        }
        if (isMuted) {
          result.muted.push(chatId);
          continue;
        }

        try {
          const ok = await send({ chatId, slug: job.slug, reason: job.reason });
          if (ok) {
            sent.set(key, now().getTime());
            result.sent.push({ chatId, slug: job.slug });
          } else {
            result.failed.push({ chatId, slug: job.slug });
          }
        } catch (err) {
          // ส่งไม่สำเร็จ = ไม่ปั๊มว่าส่งแล้ว ลูกค้ายังมีโอกาสได้การ์ดรอบหน้า
          console.warn("ส่งการ์ดไม่สำเร็จ:", err?.message ?? err);
          result.failed.push({ chatId, slug: job.slug });
        }
      }

      return result;
    },

    start() {
      if (handle) return handle;
      handle = timers.setInterval(() => {
        api.tick().catch((err) => console.error("รอบส่งการ์ดล้ม:", err));
      }, tickMs);
      handle.unref?.(); // ไม่ต้องให้ timer นี้กั้น process ตอนปิดเซิร์ฟเวอร์
      return handle;
    },

    stop() {
      if (handle) timers.clearInterval(handle);
      handle = null;
    },

    get pending() {
      return queue.size;
    },
  };

  return api;
}
