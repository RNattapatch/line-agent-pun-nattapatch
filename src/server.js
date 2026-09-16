import express from "express";
import {
  middleware,
  messagingApi,
  HTTPFetchError,
  SignatureValidationFailed,
  JSONParseError,
} from "@line/bot-sdk";

import { loadDotEnv } from "./env.js";
import { IMAGE_DIR, readCache } from "./image-cache.js";
import { askBrain, loadBrain } from "./brain.js";
import { DEFAULT_DELAY_MS, DEFAULT_MAX_WAIT_MS, createInbox } from "./inbox.js";
import { conversations } from "./conversation.js";
import { TICK_MS, createCardDispatcher } from "./card-dispatcher.js";
import { verifyImageUrl } from "./image-verify.js";
import { createPipeline } from "./pipeline.js";
import { adminClaims } from "./admin-claim.js";
import { createEventLog } from "./customer-events.js";
import { createIncidentLog } from "./incidents.js";
import { createFaultBox } from "./faults.js";
import { createMediaStore, readStream } from "./media.js";
import { paymentDestinations, qrDestinations } from "./payment.js";
import { createReports } from "./reports.js";
import { createScheduler } from "./scheduler.js";
import { createSlipWaiters } from "./slip-flow.js";
import { createUrgentGuard } from "./urgent-guard.js";
import { runEveningReport } from "./evening-report.js";
import { qrDir } from "./qr-issue.js";
import { quoteStore } from "./quotes.js";

loadDotEnv();

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  PUBLIC_BASE_URL,
  ADMIN_USER_ID,
  ADMIN_GROUP_ID,
  PORT = 3000,
} = process.env;

/* เวลาที่รอให้ลูกค้าพิมพ์จบก่อนตอบ — ปรับได้ทาง .env โดยไม่ต้องแก้โค้ด */
const REPLY_DELAY_MS = Number(process.env.REPLY_DELAY_MS) || DEFAULT_DELAY_MS;
const REPLY_MAX_WAIT_MS = Number(process.env.REPLY_MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS;

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

/* ตัวดึงไฟล์ที่ลูกค้าส่งมา — คนละ client กับตัวส่งข้อความ (คนละ endpoint ของ LINE) */
const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});
const fetchImage = async (messageId) => readStream(await blobClient.getMessageContent(messageId));

/*
 * อ่านแคชรูปครั้งเดียวตอนบูต ไม่อ่านซ้ำทุกข้อความ
 * เปลี่ยนรูปใหม่ (npm run gen:images) แล้วต้องรีสตาร์ตเซิร์ฟเวอร์ — เขียนไว้ใน README แล้ว
 */
const imageCache = readCache();
const imageCount = Object.keys(imageCache.products ?? {}).length;
console.log(`🖼  โหลดแคชรูปสินค้า ${imageCount} รายการ`);

/*
 * สมองร้านใช้ตอบคำถามปลายเปิด ขาดไปไม่ทำให้บอทดับ — แค่กลับไปตอบข้อความสำรอง
 * แล้วส่งต่อแอดมินเหมือนก่อนมีสมอง จึงเตือนเฉย ๆ ไม่ exit
 */
const brainChars = loadBrain().length;
if (!process.env.OPENROUTER_API_KEY) {
  console.warn("⚠️  ไม่ได้ตั้ง OPENROUTER_API_KEY — คำถามปลายเปิดจะส่งต่อแอดมินทั้งหมด");
} else {
  console.log(`🧠 โหลดสมองร้าน ${brainChars.toLocaleString()} ตัวอักษร`);
}

console.log(
  `⏳ รอลูกค้าพิมพ์จบ ${(REPLY_DELAY_MS / 1000).toFixed(0)} วินาที ก่อนตอบ ` +
    `(เพดานรวม ${(REPLY_MAX_WAIT_MS / 1000).toFixed(0)} วินาที)`,
);

/*
 * ใบเสนอราคาจริงอยู่นอก repo เสมอ (~/shop-data/quotes โหมด 700 · ไฟล์ 600)
 * สร้างโฟลเดอร์ตั้งแต่บูต จะได้รู้ตั้งแต่ตอน deploy ว่าเขียนดิสก์ไม่ได้ ไม่ใช่รู้ตอนลูกค้าขอราคา
 */
try {
  quoteStore.ensure();
  console.log(`🧾 ที่เก็บใบเสนอราคา: ${quoteStore.dir}`);
} catch (err) {
  console.error(`⚠️  สร้างที่เก็บใบเสนอราคาไม่ได้ (${quoteStore.dir}) — คำขอใบเสนอราคาจะตกไปหาแอดมินทั้งหมด:`, err.message);
}

/*
 * สิทธิ์ผู้ดูแลมาจากการ claim ด้วยรหัสใช้ครั้งเดียว (ดู src/admin-claim.js)
 * ยังไม่มีใคร claim = ยังไม่มี Admin lane · รายงานทั้ง 4 งานเก็บเข้าคิวไว้ก่อน (deliver=local)
 */
try {
  adminClaims.ensure();
} catch (err) {
  console.error(`⚠️  สร้างที่เก็บสถานะผู้ดูแลไม่ได้ (${adminClaims.dir}):`, err.message);
}

const reports = createReports({ push: (args) => client.pushMessage(args) });
const events = createEventLog();
const urgent = createUrgentGuard({ events, reports });
const incidents = createIncidentLog();
const faults = createFaultBox({ claims: adminClaims });
const media = createMediaStore();
const slipWaiters = createSlipWaiters();

/*
 * กวาดของเก่าตอนบูต — ทำที่นี่ครั้งเดียว แล้วรายงานเย็นกวาดซ้ำทุกวัน
 * ของที่เลย retention แล้วต้องหายจริง ๆ ไม่ใช่ค้างอยู่เพราะไม่มีใครรันตัวกวาด
 */
for (const [what, n] of [
  ["เหตุการณ์ลูกค้า", events.sweep()],
  ["บันทึกเหตุขัดข้อง", incidents.sweep()],
  ["รูปที่ลูกค้าส่งมา", media.sweep()],
]) {
  if (n > 0) console.log(`🧹 ลบ${what}ที่เกินกำหนดเก็บแล้ว ${n} รายการ`);
}
const claimStatus = adminClaims.status();

if (claimStatus.hasAdmin) {
  console.log(`🔐 Admin lane: LINE user ลงท้าย …${claimStatus.adminSuffix} · รายงาน deliver=admin`);
} else if (ADMIN_USER_ID || ADMIN_GROUP_ID) {
  console.log("🔐 ใช้ ADMIN_USER_ID / ADMIN_GROUP_ID จาก .env (ยังไม่มีใคร claim สิทธิ์)");
} else {
  console.warn(
    `⚠️  ยังไม่มีแอดมิน — รายงานทั้ง 4 งานเก็บเข้าคิวไว้ก่อน (deliver=local · ค้างอยู่ ${reports.spoolSize()} ชิ้น)\n` +
      "    ออกรหัสด้วย: node scripts/admin-tool.mjs issue",
  );
}

/*
 * ช่องทางรับเงิน — นับให้ดูตอนบูต ไม่พิมพ์เลขบัญชีออก log เด็ดขาด
 * ขาดไปไม่ทำให้บอทดับ แค่ลูกค้าที่กดยืนยันสั่งซื้อจะถูกส่งต่อให้แอดมินแจ้งช่องทางเอง
 */
const destinations = paymentDestinations();
if (destinations.length === 0) {
  console.warn(
    "⚠️  ไม่ได้ตั้ง PAYMENT_DESTINATIONS_JSON — ลูกค้าที่กดยืนยันสั่งซื้อจะถูกส่งต่อให้แอดมินแจ้งช่องทางเอง",
  );
} else {
  /* ส่งลิสต์ที่แกะแล้วเข้าไป ไม่เรียก paymentDestinations() ซ้ำ — ไม่งั้น warning ของรายการที่กรอกผิดจะขึ้นสองรอบ */
  const names = destinations.map((d) => d.label).join(" · ");
  console.log(
    `💳 ช่องทางรับเงิน ${destinations.length} ช่อง: ${names} (ออก QR ได้ ${qrDestinations(destinations).length} ช่อง)`,
  );
}

const app = express();

// เสิร์ฟรูปสินค้าให้ LINE มาโหลด — เป็นไฟล์นิ่ง ไม่มีข้อมูลลูกค้า
app.use("/images", express.static(IMAGE_DIR, { maxAge: "7d" }));

/*
 * เสิร์ฟภาพ QR ให้ LINE มาโหลด — คนละโฟลเดอร์กับรูปสินค้าโดยสิ้นเชิง
 * (รูปสินค้าอยู่ใน repo · ภาพ QR อยู่ที่ ~/shop-data/qr นอก repo เหมือนใบเสนอราคา)
 *
 * ชื่อไฟล์เป็นสตริงสุ่ม 32 ตัวจาก crypto.randomBytes เดาไม่ได้ (ดู src/qr-issue.js)
 * ตรงนี้จึงไม่มีการตรวจสิทธิ์ — และตรวจไม่ได้ด้วย เพราะคนที่มาโหลดคือเซิร์ฟเวอร์ของ LINE
 * ไม่ใช่ตัวลูกค้า จะไม่มี session ให้ตรวจ
 *
 * แนบ "ห้ามแคช" ไว้ให้ตัวกลางระหว่างทาง: ภาพนี้ผูกกับยอดของใบเดียว ใช้ครั้งเดียว
 * และถูกกวาดทิ้งใน 24 ชม. — ไม่มีเหตุผลให้ใครเก็บสำเนาไว้
 */
app.use(
  "/qr",
  express.static(qrDir(), {
    maxAge: 0,
    etag: false,
    index: false,
    dotfiles: "deny",
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  }),
);

/*
 * เสิร์ฟรูปที่ลูกค้าส่งมา ให้เซิร์ฟเวอร์ของ LINE เข้ามาดึงไปแสดงในแชทเจ้าของร้าน
 *
 * ไม่ใช่ static — ทุกคำขอต้องมีลายเซ็นที่ยังไม่หมดอายุและยังไม่ถูกใช้จนครบ (ดู src/media.js)
 * และไม่มี index ให้ไล่ดูทั้งโฟลเดอร์
 */
app.get("/media/:file", (req, res) => {
  const id = String(req.params.file).split(".")[0];
  const verdict = media.resolve(id, { expires: req.query.e, signature: req.query.s });

  if (!verdict.ok) {
    /* ทุกเหตุตอบ 404 เหมือนกันหมด — ไม่บอกว่าไฟล์มีอยู่จริงไหม */
    console.warn(`🖼  ปฏิเสธคำขอรูป (${verdict.reason})`);
    return res.status(404).end();
  }

  res.setHeader("Content-Type", verdict.type);
  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(verdict.file);
});

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
        await pipeline.handleEvent(event);
      } catch (err) {
        logFailure("จัดการ event ไม่สำเร็จ", err);
      }
    }),
  );
});

/*
 * error จาก LINE API มี stack trace กับ header ติดมาเป็นพรืด อ่านแล้วหาสาระไม่เจอ
 * ตัวที่บอกเหตุจริงคือ status กับ body เท่านั้น — ที่เหลือเก็บไว้เฉพาะ error ที่ไม่รู้จัก
 */
function logFailure(label, err) {
  if (err instanceof HTTPFetchError) {
    console.error(`LINE API ${err.status}:`, err.body);
  } else {
    console.error(`${label}:`, err);
  }
}

/*
 * ลูกค้าพิมพ์ทีละบับเบิลสั้น ๆ ต่อกัน ถ้าตอบทันทีที่บับเบิลแรกจะตอบผิดบริบท
 * จึงพักไว้ให้ลูกค้าพิมพ์จบก่อน แล้วรวมทั้งชุดค่อยตอบครั้งเดียว (ดู src/inbox.js)
 */
const inbox = createInbox({
  delayMs: REPLY_DELAY_MS,
  maxWaitMs: REPLY_MAX_WAIT_MS,
  /* ห่อไว้ในฟังก์ชัน เพราะ pipeline ถูกสร้างทีหลัง (มันต้องรู้จัก inbox ตัวนี้) */
  onFlush: (batch) => pipeline.handleBatch(batch),
});

/*
 * ตัวส่งการ์ด — ตื่นทุก 1 นาที ส่งการ์ดที่คิวไว้ กันส่งซ้ำรายวัน และเงียบเมื่ออยู่ในบริบทชำระเงิน
 * ดูเหตุผลของแต่ละกติกาใน src/card-dispatcher.js
 */
const dispatcher = createCardDispatcher({
  tickMs: TICK_MS,
  send: (job) => pipeline.pushProductCard(job),
  muted: ({ chatId }) => pipeline.inPaymentContext(chatId),
});

/*
 * ตรรกะการตัดสินใจทั้งหมดอยู่ใน src/pipeline.js — ที่นี่แค่ต่อสายให้มัน
 * (แยกไว้เพื่อให้เทสต์เดินสถานการณ์จริงได้โดยไม่ต้องเปิดเซิร์ฟเวอร์ ดู tests/scenario.test.js)
 */
const pipeline = createPipeline({
  client,
  store: quoteStore,
  inbox,
  dispatcher,
  conversations,
  imageCache,
  baseUrl: PUBLIC_BASE_URL,
  adminUserId: ADMIN_USER_ID,
  adminGroupId: ADMIN_GROUP_ID,
  claims: adminClaims,
  reports,
  events,
  urgent,
  incidents,
  faults,
  media,
  slipWaiters,
  fetchImage,
  runEvening: ({ date, testRun } = {}) => runEveningReport({ events, reports, date, testRun }),
  askBrain,
  verifyImageUrl,
  logFailure,
});

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

const server = app.listen(PORT, () =>
  console.log(`Worker ทำงานที่ port ${PORT} — webhook: POST /webhook`),
);

dispatcher.start();
console.log(`🗂  ตัวส่งการ์ดตื่นทุก ${(TICK_MS / 1000).toFixed(0)} วินาที`);

/*
 * ยามรายงานเย็น + ยามแจ้งด่วน
 * catchUp() ต้องมาก่อน start() — ถ้า deploy หลังเวลารายงานของวันนั้นไปแล้ว
 * รายงานของวันนั้นจะหายไปเงียบ ๆ ถ้าไม่มีใครรันตามให้
 */
const scheduler = createScheduler({
  runEvening: ({ date, testRun }) => runEveningReport({ events, reports, date, testRun }),
  urgentTick: async () => {
    await urgent.tick();
    await pipeline.sweepSlipWaiters();
  },
});
scheduler.catchUp().then((r) => {
  if (r.caughtUp) console.log(`🌆 ส่งรายงานเย็นของ ${r.date} ตามให้แล้ว (เลยเวลาไปตอนเซิร์ฟเวอร์ปิดอยู่)`);
});
scheduler.start();

/*
 * ตอนรีสตาร์ต (deploy ใหม่) จะมีลูกค้าที่ข้อความยังพักอยู่ในคิว
 * ถ้าดับเลยลูกค้ากลุ่มนั้นจะไม่ได้รับคำตอบและไม่มีใครรู้ — ตอบให้จบก่อนค่อยดับ
 */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    console.log(`ได้รับ ${signal} — ตอบข้อความที่ค้างอยู่ ${inbox.size} ชุดก่อนปิด`);
    dispatcher.stop();
    scheduler.stop();
    server.close();
    try {
      await inbox.flushAll();
    } finally {
      process.exit(0);
    }
  });
}
