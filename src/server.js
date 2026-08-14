import express from "express";
import {
  middleware,
  messagingApi,
  HTTPFetchError,
  SignatureValidationFailed,
  JSONParseError,
} from "@line/bot-sdk";

import { loadDotEnv } from "./env.js";
import { buildReply } from "./reply.js";
import { IMAGE_DIR, readCache } from "./image-cache.js";

loadDotEnv();

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  PUBLIC_BASE_URL,
  ADMIN_USER_ID,
  PORT = 3000,
} = process.env;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error("ขาด CHANNEL_ACCESS_TOKEN หรือ CHANNEL_SECRET — คัดลอก .env.example เป็น .env ก่อน");
  process.exit(1);
}

/*
 * PUBLIC_BASE_URL คือโดเมน HTTPS ที่ลูกค้าเข้าถึงเซิร์ฟเวอร์นี้ได้จริง
 * LINE จะไปโหลดรูปจาก URL นี้เอง ถ้าเป็น http หรือชี้ไป localhost ลูกค้าจะเห็นรูปพัง
 * ขาดไปไม่ทำให้บอทดับ — แค่ตัดโหมดส่งรูปทิ้ง แล้วตกไปใช้ข้อความสำรอง + ส่งต่อแอดมิน
 */
if (!PUBLIC_BASE_URL?.startsWith("https://")) {
  console.warn(
    "⚠️  ไม่ได้ตั้ง PUBLIC_BASE_URL เป็น https:// — โหมดส่งรูปปิดอยู่ ลูกค้าที่ขอรูปจะได้ข้อความสำรองแทน",
  );
}

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/*
 * อ่านแคชรูปครั้งเดียวตอนบูต ไม่อ่านซ้ำทุกข้อความ
 * เปลี่ยนรูปใหม่ (npm run gen:images) แล้วต้องรีสตาร์ตเซิร์ฟเวอร์ — เขียนไว้ใน README แล้ว
 */
const imageCache = readCache();
const imageCount = Object.keys(imageCache.products ?? {}).length;
console.log(`🖼  โหลดแคชรูปสินค้า ${imageCount} รายการ`);

const app = express();

// เสิร์ฟรูปสินค้าให้ LINE มาโหลด — เป็นไฟล์นิ่ง ไม่มีข้อมูลลูกค้า
app.use("/images", express.static(IMAGE_DIR, { maxAge: "7d" }));

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

  /*
   * รูปทั้งหมดถูกสร้างไว้ล่วงหน้าแล้ว (npm run gen:images) ตรงนี้แค่หยิบจากแคช
   * เลยตอบได้ในระดับมิลลิวินาที ทันหน้าต่าง 10 วินาทีของ LINE เสมอ
   */
  const { messages, escalate } = buildReply(text, { baseUrl: PUBLIC_BASE_URL, cache: imageCache });

  /*
   * ใช้ replyMessage ไม่ใช่ pushMessage:
   * reply ภายใน 24 ชม.ไม่กินโควตารายเดือน ส่วน push กิน
   */
  await client.replyMessage({ replyToken: event.replyToken, messages });

  if (escalate) await notifyAdmin(escalate, event);
}

/*
 * ส่งต่อแอดมิน — ลง log เสมอ และถ้าตั้ง ADMIN_USER_ID ไว้จะ push หาแอดมินด้วย
 * push กินโควตารายเดือน เลยยิงเฉพาะตอนที่ต้องให้คนมารับช่วงจริง ๆ และปิดไว้เป็นค่าเริ่มต้น
 */
async function notifyAdmin(reason, event) {
  const userId = event.source?.userId ?? "unknown";
  // log ตัดไอดีเหลือ 8 ตัวพอให้ไล่หาแชทได้ ไม่ต้องเก็บไอดีลูกค้าเต็ม ๆ ไว้ในไฟล์ log
  console.warn(`🔔 ส่งต่อแอดมิน: ${reason} (user ${userId.slice(0, 8)}…)`);

  if (!ADMIN_USER_ID) return;
  try {
    await client.pushMessage({
      to: ADMIN_USER_ID,
      messages: [{ type: "text", text: `🔔 ลูกค้ารอแอดมิน\n${reason}\nuserId: ${userId}` }],
    });
  } catch (err) {
    // แจ้งแอดมินไม่สำเร็จก็ไม่ควรทำให้ลูกค้าได้ error — ลูกค้าได้ข้อความไปแล้ว
    console.error("แจ้งแอดมินไม่สำเร็จ:", err instanceof HTTPFetchError ? err.status : err.message);
  }
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
