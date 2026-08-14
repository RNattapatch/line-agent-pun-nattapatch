/*
 * ตัวพักข้อความ — รอให้ลูกค้าพิมพ์จบก่อนค่อยตอบ
 *
 * ลูกค้าคนไทยพิมพ์ทีละบับเบิลสั้น ๆ ต่อกันเป็นชุด เช่น
 *   "สนใจบราวนี่" → "กล่อง 6 ชิ้น" → "ส่งพรุ่งนี้ได้ไหม"
 * ถ้าตอบทันทีที่บับเบิลแรก บอทจะตอบผิดบริบท แล้วบทสนทนาก็รวนทั้งชุด
 * เสียโอกาสปิดการขายทั้งที่ลูกค้าตั้งใจซื้อ
 *
 * ตรงนี้เลยพักไว้ก่อน แล้วรวมทุกบับเบิลเป็นข้อความเดียวค่อยส่งให้ตัวตอบ
 * ทุกครั้งที่มีข้อความใหม่เข้ามา นาฬิกาจะเริ่มนับใหม่ — ลูกค้าหยุดพิมพ์เมื่อไหร่จึงตอบ
 *
 * ไม่มี state ในดิสก์ ทุกอย่างอยู่ในหน่วยความจำ — รีสตาร์ตแล้วชุดที่ค้างอยู่จะหาย
 * ยอมรับได้เพราะเป็นหน้าต่างแค่ไม่กี่วินาที และ LINE จะไม่ retry event ที่ตอบ 200 ไปแล้ว
 */

/* รอหลังลูกค้าพิมพ์ข้อความล่าสุด — 7 วิ อยู่กลางช่วง 5–10 วิที่ใช้ได้จริง */
export const DEFAULT_DELAY_MS = 7_000;

/*
 * เพดานรวม — ลูกค้าที่พิมพ์ยาวรัวไม่หยุดต้องได้คำตอบสักที ไม่ใช่รอไปเรื่อย ๆ
 * นับจากบับเบิลแรกของชุด
 */
export const DEFAULT_MAX_WAIT_MS = 30_000;

/* บับเบิลต่อชุด เกินนี้ตอบเลยไม่ต้องรอ — กันทั้งเปลือง token และกันหน่วยความจำบวม */
export const DEFAULT_MAX_MESSAGES = 15;

/*
 * onFlush({ chatId, texts, replyToken, event, reason }) — เรียกเมื่อถึงเวลาตอบ
 *   texts      บับเบิลทั้งชุดตามลำดับที่ลูกค้าพิมพ์
 *   replyToken token ของข้อความล่าสุด (ใหม่ที่สุด = อายุเหลือมากที่สุด)
 *   reason     "idle" ลูกค้าหยุดพิมพ์ · "maxWait" ครบเพดานเวลา · "maxMessages" ครบเพดานบับเบิล
 *
 * timers รับเข้ามาเพื่อให้เทสต์เดินนาฬิกาเองได้ ไม่ต้องรอจริง
 */
export function createInbox({
  delayMs = DEFAULT_DELAY_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  maxMessages = DEFAULT_MAX_MESSAGES,
  onFlush,
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
} = {}) {
  if (typeof onFlush !== "function") throw new TypeError("createInbox ต้องมี onFlush");

  /* chatId -> ชุดข้อความที่ยังพักอยู่ */
  const pending = new Map();

  const cancelTimer = (entry) => {
    if (entry.timer !== null) {
      timers.clearTimeout(entry.timer);
      entry.timer = null;
    }
  };

  async function flush(chatId, reason) {
    const entry = pending.get(chatId);
    if (!entry) return;

    cancelTimer(entry);
    pending.delete(chatId);

    try {
      await onFlush({
        chatId,
        texts: entry.texts,
        replyToken: entry.replyToken,
        event: entry.event,
        reason,
      });
    } catch (err) {
      // ตัวตอบพังไม่ควรทำให้ทั้ง process ล้ม — ลูกค้าคนอื่นยังต้องได้รับบริการ
      console.error("ตอบชุดข้อความไม่สำเร็จ:", err);
    }
  }

  return {
    /* รับข้อความเข้ามาพัก แล้วเริ่มนับเวลาใหม่ */
    add(chatId, { text, replyToken, event } = {}) {
      let entry = pending.get(chatId);
      if (!entry) {
        entry = { texts: [], replyToken: null, event: null, timer: null, firstAt: now() };
        pending.set(chatId, entry);
      }

      entry.texts.push(String(text ?? ""));
      // เก็บ token ล่าสุดเสมอ ของเดิมจะถูกทิ้งไปโดยไม่ได้ใช้ ซึ่งไม่เสียหายอะไร
      entry.replyToken = replyToken ?? entry.replyToken;
      entry.event = event ?? entry.event;

      if (entry.texts.length >= maxMessages) return flush(chatId, "maxMessages");

      cancelTimer(entry);

      // ครบเพดานรวมแล้วต้องตอบทันที ไม่ต่อเวลาให้อีก
      const elapsed = now() - entry.firstAt;
      if (elapsed >= maxWaitMs) return flush(chatId, "maxWait");

      const wait = Math.min(delayMs, maxWaitMs - elapsed);
      entry.timer = timers.setTimeout(() => {
        flush(chatId, elapsed + wait >= maxWaitMs ? "maxWait" : "idle");
      }, wait);

      return undefined;
    },

    /* จำนวนชุดที่ยังค้างอยู่ — ใช้ตอนเทสต์และตอนดูสถานะ */
    get size() {
      return pending.size;
    },

    /* ตอบทุกชุดที่ค้างทันที เช่นตอนกำลังจะปิดเซิร์ฟเวอร์ */
    async flushAll(reason = "shutdown") {
      await Promise.all([...pending.keys()].map((chatId) => flush(chatId, reason)));
    },
  };
}

/*
 * รวมบับเบิลเป็นข้อความเดียว
 * ขึ้นบรรทัดใหม่ให้สมองร้านเห็นว่าลูกค้าพิมพ์มาเป็นชุด ไม่ใช่ประโยคเดียวยาว ๆ
 * ส่วนกฎตายตัวใน reply.js ใช้ \s ในการแมตช์อยู่แล้ว จึงอ่านได้เหมือนกัน
 */
export const combine = (texts) =>
  texts
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .join("\n");
