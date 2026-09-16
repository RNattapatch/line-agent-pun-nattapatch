/*
 * เทสต์ตัวส่งการ์ด + ความจำบทสนทนา
 * ข้อที่สำคัญที่สุดคือ "เงียบตอนลูกค้าส่งสลิป" — ผิดข้อนี้แล้วลูกค้าไม่แน่ใจว่าร้านได้เงินหรือยัง
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createCardDispatcher } from "../src/card-dispatcher.js";
import { createConversations } from "../src/conversation.js";

function setup({ muted = () => false, now } = {}) {
  const sent = [];
  const dispatcher = createCardDispatcher({
    send: async ({ chatId, slug }) => {
      sent.push(`${chatId}:${slug}`);
      return true;
    },
    muted,
    now,
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
  });
  return { dispatcher, sent };
}

test("คิว intent แล้วรอบถัดไปส่งการ์ดที่ตรงรุ่น", async () => {
  const { dispatcher, sent } = setup();

  dispatcher.queue("U1", "brownie-box");
  assert.deepEqual(sent, [], "ยังไม่ถึงรอบ ห้ามส่ง");

  const result = await dispatcher.tick();
  assert.deepEqual(sent, ["U1:brownie-box"]);
  assert.equal(result.sent.length, 1);
});

test("กันส่งซ้ำรายวัน — ถามรุ่นเดิม 5 รอบก็ได้การ์ดใบเดียว", async () => {
  const { dispatcher, sent } = setup();

  for (let i = 0; i < 5; i++) {
    dispatcher.queue("U1", "brownie-box");
    await dispatcher.tick();
  }

  assert.deepEqual(sent, ["U1:brownie-box"], "วันเดียวกันต้องได้ใบเดียว");
});

test("ขึ้นวันใหม่ → ส่งรุ่นเดิมซ้ำได้", async () => {
  let clock = new Date("2026-09-16T10:00:00");
  const { dispatcher, sent } = setup({ now: () => clock });

  dispatcher.queue("U1", "brownie-box");
  await dispatcher.tick();

  clock = new Date("2026-09-17T09:00:00");
  dispatcher.queue("U1", "brownie-box");
  await dispatcher.tick();

  assert.deepEqual(sent, ["U1:brownie-box", "U1:brownie-box"]);
});

test("ตัวตอบส่งการ์ดไปแล้ว → ตัวส่งการ์ดต้องไม่ยิงซ้ำ", async () => {
  const { dispatcher, sent } = setup();

  dispatcher.markSent("U1", "shio-pan"); // buildReply ตอบการ์ดไปแล้วในจังหวะเดียวกัน
  assert.equal(dispatcher.queue("U1", "shio-pan"), false, "ส่งไปแล้ว ห้ามรับเข้าคิวอีก");

  await dispatcher.tick();
  assert.deepEqual(sent, []);
});

test("คิวใหม่ทับคิวเก่าในห้องเดียวกัน — ลูกค้าเปลี่ยนใจต้องได้รุ่นที่พูดล่าสุด", async () => {
  const { dispatcher, sent } = setup();

  dispatcher.queue("U1", "brownie-box");
  dispatcher.queue("U1", "shio-pan");
  await dispatcher.tick();

  assert.deepEqual(sent, ["U1:shio-pan"], "ต้องได้ใบเดียว และเป็นรุ่นล่าสุด");
});

test("อยู่ในบริบทชำระเงิน → เงียบสนิท ไม่ส่งการ์ดสินค้าใด ๆ", async () => {
  const { dispatcher, sent } = setup({ muted: ({ chatId }) => chatId === "U1" });

  dispatcher.queue("U1", "brownie-box");
  dispatcher.queue("U2", "shio-pan");
  const result = await dispatcher.tick();

  assert.deepEqual(sent, ["U2:shio-pan"], "ห้องที่กำลังจ่ายเงินต้องไม่ได้การ์ด");
  assert.deepEqual(result.muted, ["U1"]);
});

test("เช็คบริบทชำระเงินตอนจะส่งจริง ไม่ใช่ตอนคิว", async () => {
  let paying = false;
  const { dispatcher, sent } = setup({ muted: () => paying });

  dispatcher.queue("U1", "brownie-box"); // ตอนคิวยังไม่ได้จ่ายเงิน
  paying = true; // ลูกค้าส่งสลิปมาระหว่างรอ
  await dispatcher.tick();

  assert.deepEqual(sent, [], "สถานะเปลี่ยนระหว่างรอ ต้องเงียบตาม");
});

test("เช็คสถานะไม่ได้ → เงียบไว้ก่อน (ปลอดภัยกว่าส่งผิดจังหวะ)", async () => {
  const { dispatcher, sent } = setup({
    muted: () => {
      throw new Error("อ่านที่เก็บไม่ได้");
    },
  });

  dispatcher.queue("U1", "brownie-box");
  const result = await dispatcher.tick();

  assert.deepEqual(sent, []);
  assert.deepEqual(result.muted, ["U1"]);
});

test("ส่งไม่สำเร็จ → ไม่ปั๊มว่าส่งแล้ว ลูกค้ายังมีโอกาสได้การ์ดรอบหน้า", async () => {
  let works = false;
  const dispatcher = createCardDispatcher({
    send: async () => works,
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
  });

  dispatcher.queue("U1", "brownie-box");
  await dispatcher.tick();
  assert.equal(dispatcher.alreadySent("U1", "brownie-box"), false);

  works = true;
  assert.equal(dispatcher.queue("U1", "brownie-box"), true, "ยังคิวใหม่ได้");
  const result = await dispatcher.tick();
  assert.equal(result.sent.length, 1);
});

/* ───────── ความจำบทสนทนา ───────── */

test('"มีรูปไหม" ที่ไม่บอกรุ่น → ย้อนหาจากข้อความลูกค้า', () => {
  const convo = createConversations();

  convo.remember("U1", { role: "customer", text: "บราวนี่กล่อง 6 ชิ้นเท่าไหร่คะ" });
  convo.remember("U1", { role: "shop", text: "189 บาทค่ะ" });
  convo.remember("U1", { role: "customer", text: "มีรูปไหม" });

  assert.equal(convo.lastProductSlug("U1"), "brownie-box");
});

test("ย้อนหาจาก 'คำตอบของร้าน' ได้ด้วย ไม่ใช่แค่ข้อความลูกค้า", () => {
  const convo = createConversations();

  /* ลูกค้าไม่เคยพิมพ์ชื่อเต็ม — คนที่เอ่ยชื่อรุ่นชัด ๆ คือฝั่งร้าน */
  convo.remember("U1", { role: "customer", text: "อันที่เป็นกล่องอะคะ" });
  convo.remember("U1", { role: "shop", text: "บราวนี่ (กล่อง 6 ชิ้น) 189 บาท / กล่อง" });
  convo.remember("U1", { role: "customer", text: "ขอดูรูปหน่อย" });

  assert.equal(convo.lastProductSlug("U1"), "brownie-box");
});

test("ไม่มีบริบทให้ยึด → คืน null (ผู้เรียกต้องถามกลับ ห้ามเดา)", () => {
  const convo = createConversations();

  convo.remember("U1", { role: "customer", text: "สวัสดีค่ะ" });
  convo.remember("U1", { role: "customer", text: "มีรูปไหม" });

  assert.equal(convo.lastProductSlug("U1"), null);
});

test("คำกว้างอย่าง 'บราวนี่' ยังกำกวม ไม่นับเป็นบริบทที่ชัด", () => {
  const convo = createConversations();
  convo.remember("U1", { role: "customer", text: "สนใจบราวนี่ค่ะ" });

  assert.equal(convo.lastProductSlug("U1"), null, "ชี้ได้ทั้งชิ้นและกล่อง ต้องถามกลับ");
});

test("ห้องใครห้องมัน — บริบทไม่ข้ามห้อง", () => {
  const convo = createConversations();
  convo.remember("U1", { role: "customer", text: "ขอดูบราวนี่กล่อง" });

  assert.equal(convo.lastProductSlug("U2"), null);
});

test("event ล่าสุดของลูกค้าเป็นรูป → ถือว่าอยู่ในบริบทชำระเงิน", () => {
  const convo = createConversations();

  convo.remember("U1", { role: "customer", text: "สนใจบราวนี่กล่อง" });
  assert.equal(convo.inPaymentContext("U1"), false);

  convo.remember("U1", { role: "customer", kind: "image" });
  assert.equal(convo.inPaymentContext("U1"), true, "รูปสลิปไม่ใช่ความสนใจสินค้า");
});

test("คำจำพวก โอนแล้ว/สลิป/ชำระ/จ่ายแล้ว → บริบทชำระเงิน", () => {
  for (const word of ["โอนแล้วค่ะ", "ส่งสลิปให้แล้วนะคะ", "ชำระเงินเรียบร้อยค่ะ", "จ่ายแล้วค่ะ"]) {
    const convo = createConversations();
    convo.remember("U1", { role: "customer", text: word });
    assert.equal(convo.inPaymentContext("U1"), true, `"${word}" ต้องทำให้ตัวส่งการ์ดเงียบ`);
  }
});

test("ร้านเป็นคนพูดคำว่าชำระเงิน ไม่นับ — ต้องเป็นลูกค้าเท่านั้น", () => {
  const convo = createConversations();
  convo.remember("U1", { role: "shop", text: "ชำระเงินได้ที่พร้อมเพย์นะคะ" });

  assert.equal(convo.inPaymentContext("U1"), false);
});

test("ส่งรูป + พิมพ์ 'โอนแล้ว' → ตัวส่งการ์ดต้องไม่ส่งการ์ดสินค้าใด ๆ ตามมา", async () => {
  const convo = createConversations();
  const { dispatcher, sent } = setup({ muted: ({ chatId }) => convo.inPaymentContext(chatId) });

  /* ลูกค้าคุยเรื่องสินค้าไว้ก่อน แล้วค่อยเข้าโหมดจ่ายเงิน */
  convo.remember("U1", { role: "customer", text: "สนใจบราวนี่กล่อง" });
  dispatcher.queue("U1", "brownie-box");

  convo.remember("U1", { role: "customer", kind: "image" }); // สลิป
  convo.remember("U1", { role: "customer", text: "โอนแล้วค่ะ" });

  await dispatcher.tick();
  assert.deepEqual(sent, [], "ห้ามมีการ์ดสินค้าตามหลังสลิปเด็ดขาด");

  /* แม้จะพยายามคิวใหม่หลังจากนั้นก็ยังต้องเงียบ */
  dispatcher.queue("U1", "shio-pan");
  await dispatcher.tick();
  assert.deepEqual(sent, []);
});
