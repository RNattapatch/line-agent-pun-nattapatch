/*
 * เทสต์ตัวพักข้อความ — เดินนาฬิกาเองทั้งหมด ไม่มี sleep จริงสักข้อ
 * เทสต์ชุดนี้จึงจบในไม่กี่มิลลิวินาที แม้จะจำลองการรอ 30 วินาที
 */

import assert from "node:assert/strict";
import test from "node:test";

import { combine, createInbox } from "../src/inbox.js";

/* นาฬิกาปลอม — เดินเวลาเองได้ ทำให้เทสต์ deterministic */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const jobs = new Map();

  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++seq;
        jobs.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (id) => jobs.delete(id),
    },
    /* เดินเวลาไปข้างหน้า แล้วรันงานที่ถึงกำหนดตามลำดับเวลา */
    async advance(ms) {
      const target = now + ms;
      let next;
      while ((next = [...jobs.entries()].filter(([, j]) => j.at <= target).sort((a, b) => a[1].at - b[1].at)[0])) {
        const [id, job] = next;
        jobs.delete(id);
        now = job.at;
        await job.fn();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

const setup = (opts = {}) => {
  const clock = fakeClock();
  const flushes = [];
  const inbox = createInbox({
    delayMs: 7000,
    maxWaitMs: 30_000,
    maxMessages: 15,
    timers: clock.timers,
    now: clock.now,
    onFlush: async (batch) => {
      flushes.push(batch);
    },
    ...opts,
  });
  return { clock, flushes, inbox };
};

const add = (inbox, chatId, text, token) => inbox.add(chatId, { text, replyToken: token, event: { chatId } });

test("ยังไม่ครบเวลา → ยังไม่ตอบ", async () => {
  const { clock, flushes, inbox } = setup();

  add(inbox, "U1", "สนใจบราวนี่", "t1");
  await clock.advance(6999);

  assert.equal(flushes.length, 0, "ยังไม่ถึงเวลา ห้ามตอบ");
  assert.equal(inbox.size, 1);
});

test("ลูกค้าหยุดพิมพ์ครบเวลา → ตอบรวมทีเดียว ตามลำดับที่พิมพ์", async () => {
  const { clock, flushes, inbox } = setup();

  add(inbox, "U1", "สนใจบราวนี่", "t1");
  await clock.advance(2000);
  add(inbox, "U1", "กล่อง 6 ชิ้น", "t2");
  await clock.advance(3000);
  add(inbox, "U1", "ส่งพรุ่งนี้ได้ไหม", "t3");

  await clock.advance(6999);
  assert.equal(flushes.length, 0, "นาฬิกาต้องเริ่มนับใหม่ทุกครั้งที่มีข้อความใหม่");

  await clock.advance(1);
  assert.equal(flushes.length, 1, "ตอบครั้งเดียว ไม่ใช่ 3 ครั้ง");
  assert.deepEqual(flushes[0].texts, ["สนใจบราวนี่", "กล่อง 6 ชิ้น", "ส่งพรุ่งนี้ได้ไหม"]);
  assert.equal(flushes[0].reason, "idle");
});

test("ใช้ reply token ของข้อความล่าสุด (อายุเหลือมากที่สุด)", async () => {
  const { clock, flushes, inbox } = setup();

  add(inbox, "U1", "หนึ่ง", "t1");
  await clock.advance(1000);
  add(inbox, "U1", "สอง", "t2");
  await clock.advance(1000);
  add(inbox, "U1", "สาม", "t3");
  await clock.advance(7000);

  assert.equal(flushes[0].replyToken, "t3");
});

test("ลูกค้าหลายคนพร้อมกัน → แยกชุดกัน ไม่ปนกัน", async () => {
  const { clock, flushes, inbox } = setup();

  add(inbox, "U1", "ลูกค้าเอ", "a1");
  add(inbox, "U2", "ลูกค้าบี", "b1");
  await clock.advance(3000);
  add(inbox, "U1", "เอถามต่อ", "a2");

  await clock.advance(7000);

  assert.equal(flushes.length, 2);
  const byChat = Object.fromEntries(flushes.map((f) => [f.chatId, f.texts]));
  assert.deepEqual(byChat.U1, ["ลูกค้าเอ", "เอถามต่อ"]);
  assert.deepEqual(byChat.U2, ["ลูกค้าบี"]);
});

test("พิมพ์รัวไม่หยุด → ตอบเมื่อครบเพดานเวลา ไม่รอตลอดกาล", async () => {
  const { clock, flushes, inbox } = setup();

  // พิมพ์ทุก 3 วินาที ไม่ให้นาฬิกา idle ครบสักที
  for (let i = 0; i < 10; i++) {
    add(inbox, "U1", `ข้อความที่ ${i}`, `t${i}`);
    await clock.advance(3000);
    if (flushes.length) break;
  }

  assert.equal(flushes.length, 1, "ต้องตอบเมื่อครบเพดานเวลา");
  assert.equal(flushes[0].reason, "maxWait");
});

test("บับเบิลเยอะเกินเพดาน → ตอบทันที ไม่รอ", async () => {
  const { flushes, inbox } = setup({ maxMessages: 3 });

  add(inbox, "U1", "หนึ่ง", "t1");
  add(inbox, "U1", "สอง", "t2");
  await add(inbox, "U1", "สาม", "t3");

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].reason, "maxMessages");
  assert.deepEqual(flushes[0].texts, ["หนึ่ง", "สอง", "สาม"]);
});

test("ตอบแล้วเคลียร์ชุดทิ้ง — ข้อความถัดไปเริ่มชุดใหม่ ไม่ซ้ำของเก่า", async () => {
  const { clock, flushes, inbox } = setup();

  add(inbox, "U1", "รอบแรก", "t1");
  await clock.advance(7000);
  assert.equal(inbox.size, 0, "ตอบแล้วต้องไม่มีชุดค้าง");

  add(inbox, "U1", "รอบสอง", "t2");
  await clock.advance(7000);

  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[1].texts, ["รอบสอง"], "ห้ามมีข้อความรอบแรกติดมา");
});

test("ตัวตอบพัง → ไม่ทำให้ทั้งระบบล้ม และไม่ค้างชุดไว้", async () => {
  const clock = fakeClock();
  const inbox = createInbox({
    delayMs: 7000,
    timers: clock.timers,
    now: clock.now,
    onFlush: async () => {
      throw new Error("ตัวตอบพัง");
    },
  });

  add(inbox, "U1", "สวัสดี", "t1");
  await clock.advance(7000);

  assert.equal(inbox.size, 0, "ต้องไม่ค้างชุดไว้จนลูกค้าคนนั้นตอบไม่ได้อีกเลย");
});

test("flushAll ตอบทุกชุดที่ค้างทันที (ตอนปิดเซิร์ฟเวอร์)", async () => {
  const { flushes, inbox } = setup();

  add(inbox, "U1", "เอ", "a");
  add(inbox, "U2", "บี", "b");
  await inbox.flushAll();

  assert.equal(flushes.length, 2);
  assert.equal(inbox.size, 0);
  for (const f of flushes) assert.equal(f.reason, "shutdown");
});

test("combine() รวมบับเบิลเป็นข้อความเดียว ตัดช่องว่างและบับเบิลว่างทิ้ง", () => {
  assert.equal(combine(["สนใจบราวนี่", "กล่อง 6 ชิ้น"]), "สนใจบราวนี่\nกล่อง 6 ชิ้น");
  assert.equal(combine(["  เว้นวรรค  ", "", "   ", "ท้าย"]), "เว้นวรรค\nท้าย");
  assert.equal(combine([]), "");
});

test("ข้อความที่รวมแล้วยังเข้ากฎตายตัวได้ถูกต้อง", async () => {
  const { buildReply } = await import("../src/reply.js");
  const cache = { products: { "brownie-box": { name: "x", path: "/images/brownie-box.jpg" } } };

  // ลูกค้าพิมพ์ 2 บับเบิล: "ขอดูรูป" แล้วตามด้วย "บราวนี่กล่อง"
  const r = buildReply(combine(["ขอดูรูป", "บราวนี่กล่อง"]), {
    baseUrl: "https://x.example.com",
    cache,
  });

  const image = r.messages.find((m) => m.type === "image");
  assert.ok(image, "รวมบับเบิลแล้วต้องรู้ว่าลูกค้าขอรูปบราวนี่กล่อง");
  assert.match(image.originalContentUrl, /brownie-box\.jpg$/);
});
