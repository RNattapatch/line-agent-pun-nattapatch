import express from "express";
import {
  middleware,
  messagingApi,
  HTTPFetchError,
  SignatureValidationFailed,
  JSONParseError,
} from "@line/bot-sdk";

const { CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, PORT = 3000 } = process.env;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error("ขาด CHANNEL_ACCESS_TOKEN หรือ CHANNEL_SECRET — คัดลอก .env.example เป็น .env ก่อน");
  process.exit(1);
}

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

const app = express();

// health check สำหรับ uptime monitor / platform ที่ deploy อยู่
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/*
 * middleware() ของ SDK ตรวจ header x-line-signature ด้วย CHANNEL_SECRET
 * ถ้าลายเซ็นไม่ตรงจะโยน 401 ทิ้งให้เอง — กันคนยิง endpoint นี้มั่ว ๆ
 * ต้องวางก่อน express.json() เพราะการตรวจลายเซ็นต้องใช้ raw body
 */
app.post("/webhook", middleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  // ตอบ 200 ทันที ไม่ให้ LINE รอ ถ้าเกิน 10 วินาที LINE จะถือว่า timeout แล้ว retry
  res.status(200).end();

  await Promise.all(
    (req.body.events ?? []).map(async (event) => {
      try {
        await handleEvent(event);
      } catch (err) {
        if (err instanceof HTTPFetchError) {
          console.error(`LINE API ${err.status}:`, err.body);
        } else {
          console.error("จัดการ event ไม่สำเร็จ:", err);
        }
      }
    }),
  );
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const reply = await buildReply(text);

  /*
   * ใช้ replyMessage ไม่ใช่ pushMessage:
   * reply ภายใน 24 ชม.ไม่กินโควตารายเดือน ส่วน push กิน
   */
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: reply }],
  });
}

// จุดที่จะต่อ logic ร้านจริง (เมนู ราคา สต็อก ฯลฯ)
async function buildReply(text) {
  if (/^(สวัสดี|hi|hello)/i.test(text)) {
    return "สวัสดีครับ 🙏 ร้านเรายินดีให้บริการ พิมพ์ 'เมนู' เพื่อดูรายการสินค้าได้เลยครับ";
  }
  if (text === "เมนู") {
    return "ตอนนี้ยังไม่ได้ตั้งค่าเมนูครับ — แก้ไขฟังก์ชัน buildReply() ใน src/server.js";
  }
  return `ได้รับข้อความแล้วครับ: "${text}"`;
}

/*
 * ถ้าไม่ดักตรงนี้ Express จะเหมา error จาก middleware เป็น 500 + พ่น stack trace ออกไป
 * ลายเซ็นไม่ผ่าน = คำขอไม่มีสิทธิ์ ต้องตอบ 401 และไม่บอกรายละเอียดว่าพังตรงไหน
 */
app.use((err, _req, res, _next) => {
  if (err instanceof SignatureValidationFailed) {
    console.warn("ปฏิเสธคำขอ: ลายเซ็นไม่ถูกต้อง");
    return res.status(401).json({ error: "invalid signature" });
  }
  if (err instanceof JSONParseError) {
    console.warn("ปฏิเสธคำขอ: body ไม่ใช่ JSON ที่ถูกต้อง");
    return res.status(400).json({ error: "invalid json" });
  }
  console.error("ข้อผิดพลาดที่ไม่คาดคิด:", err);
  return res.status(500).json({ error: "internal error" });
});

app.listen(PORT, () => console.log(`Worker ทำงานที่ port ${PORT} — webhook: POST /webhook`));
