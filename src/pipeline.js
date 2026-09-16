/*
 * ท่อประมวลผลข้อความ — ตรรกะทั้งหมดของ "รับ event มาแล้วตัดสินใจจะตอบอะไร"
 *
 * แยกออกจาก server.js เพื่อให้เทสต์เดินสถานการณ์จริงได้ทั้งเส้น
 * (ลูกค้าถามราคา → ถามต่อว่ามีรูปไหม → ขอใบเสนอราคา → ส่งสลิป)
 * โดยไม่ต้องเปิดพอร์ต ไม่ต้องมี LINE token และไม่ต้องยิงเน็ตจริง
 * server.js เหลือหน้าที่แค่ต่อสาย: อ่าน .env · ตรวจลายเซ็น · เสิร์ฟรูป · ปลุกตัวส่งการ์ด
 *
 * ทุกอย่างที่แตะโลกภายนอกถูกส่งเข้ามาทาง deps — client, store, dispatcher,
 * conversations, askBrain, verifyImageUrl — เทสต์จึงสลับเป็นตัวปลอมได้ทุกตัว
 */

import { HTTPFetchError } from "@line/bot-sdk";

import { CLAIM, adminClaims, looksLikeCode } from "./admin-claim.js";
import { NOT_ADMIN_REPLY, ADMIN_ONLY_REPLY, isAdminLane, parseCommand, runCommand } from "./admin.js";
import { handleQrRequest, parsePostback } from "./payment-flow.js";
import { NO_IMAGE_REPLY, browseReply, buildReply } from "./reply.js";
import { productCard } from "./cards.js";
import { bySlug, matchProduct } from "./products.js";
import { wantsCard } from "./quote-intent.js";
import { CONFIRM_RE, handleConfirm, handleQuoteRequest, handleSlip, sendQuote } from "./quote-flow.js";
import { PAYMENT_STATUSES } from "./quotes.js";
import { combine } from "./inbox.js";

/*
 * ข้อความเดียวกันสำหรับทุกกรณีที่ claim ไม่สำเร็จ — ผิด หมดอายุ หรือใช้ไปแล้ว
 * ถ้าแยกข้อความตามเหตุ คนที่ไล่เดารหัสจะรู้ว่า "รหัสนี้มีอยู่จริงแต่หมดอายุ" ซึ่งบอกว่าเดาถูกแล้ว
 * เจ้าของร้านตัวจริงดูเหตุผลที่แท้จริงได้จาก `admin-tool.mjs status` อยู่แล้ว
 */
export const CLAIM_FAILED_REPLY =
  "ขออภัยค่ะ รหัสนี้ใช้ไม่ได้ค่ะ หากมีเรื่องสินค้า ราคา หรือการสั่งซื้อ ยินดีตอบให้เลยค่ะ";

export const CLAIM_OK_REPLY =
  "ยืนยันสิทธิ์ผู้ดูแลเรียบร้อยแล้วค่ะ\nห้องนี้จะรับรายงานและแจ้งเตือนของร้านตั้งแต่นี้ไป และจะไม่ตอบคำถามฝั่งขายอีกนะคะ";

export function createPipeline({
  client,
  store,
  inbox,
  dispatcher,
  conversations,
  imageCache,
  baseUrl,
  adminUserId,
  adminGroupId,
  claims = adminClaims,
  reports,
  askBrain = async () => null,
  verifyImageUrl = async () => true,
  logFailure = (label, err) => console.error(`${label}:`, err),
}) {
  /*
   * "ห้ามส่งการ์ดสินค้า" ครบทั้ง 3 ข้อของโจทย์:
   *   ก+ข  อยู่ใน src/conversation.js (event ล่าสุดเป็นรูป / มีคำจำพวก โอนแล้ว-สลิป-ชำระ)
   *   ค    ใบเสนอราคาของลูกค้าคนนี้อยู่สถานะ "ส่งลูกค้า" หรือ "รับสลิปแล้ว" — ต้องอ่านจากดิสก์
   */
  function inPaymentContext(chatId) {
    if (conversations.inPaymentContext(chatId)) return true;
    try {
      return store.byUser(chatId).some((q) => PAYMENT_STATUSES.has(q.status));
    } catch {
      // อ่านที่เก็บไม่ได้ — ตัวส่งการ์ดจะถือว่าเงียบไว้ก่อน (ดู tick() ใน card-dispatcher.js)
      throw new Error("อ่านสถานะใบเสนอราคาไม่ได้");
    }
  }

  /* ส่งการ์ดสินค้าแบบ push (ใช้โควตารายเดือน) — คืน true เมื่อส่งสำเร็จจริง */
  async function pushProductCard({ chatId, slug }) {
    const card = productCard(slug, { baseUrl, cache: imageCache });
    if (!card) return false;

    /* การ์ด Flex ที่รูปพังจะส่ง "สำเร็จ" แล้วขึ้นกรอบเทาในแชทลูกค้า — ต้องตรวจเอง */
    if (!(await verifyImageUrl(card.imageUrl))) {
      console.warn(`🖼  ข้ามการ์ด ${slug}: รูปตรวจไม่ผ่าน`);
      return false;
    }

    await client.pushMessage({ to: chatId, messages: [card.message] });
    conversations.remember(chatId, { role: "shop", kind: "text", text: card.message.altText });
    return true;
  }

  async function handleEvent(event) {
    if (event.type !== "message" && event.type !== "postback") return;

    // กลุ่ม/ห้องใช้ id ของกลุ่ม ไม่งั้นข้อความจากคนละคนในกลุ่มเดียวกันจะแยกชุดกันจนตอบมั่ว
    const chatId = event.source?.groupId ?? event.source?.roomId ?? event.source?.userId;
    if (!chatId) return;

    /*
     * ── ปุ่มบนการ์ดช่องทางชำระเงิน ──
     * ไม่ผ่าน inbox (ตัวพักข้อความ 7 วิ) โดยตั้งใจ — การกดปุ่มคือเจตนาที่จบในตัวแล้ว
     * ไม่ใช่บับเบิลที่ต้องรอดูว่าลูกค้าจะพิมพ์ต่ออะไร และลูกค้าที่กดขอ QR กำลังรอภาพอยู่
     */
    if (event.type === "postback") {
      await handlePostbackEvent(event, chatId);
      return;
    }

    /*
     * ── รหัส claim สิทธิ์ผู้ดูแล ──
     *
     * ต้องดักตรงนี้ "ก่อน" conversations.remember() และก่อน inbox.add() เสมอ
     * เพราะทุกอย่างหลังจากบรรทัดนี้จะพารหัสไปไว้ในที่ที่ไม่ควรมีมัน:
     *   remember() → ความจำบทสนทนา ซึ่งถูกส่งต่อให้สมองร้านเป็นบริบท
     *   inbox      → ถูกรวมกับบับเบิลอื่นแล้ว log จำนวนบับเบิล
     *   askBrain   → ยิงข้อความออกนอกเครื่องไปที่ผู้ให้บริการโมเดล
     *
     * ไม่ว่ารหัสจะถูก ผิด หมดอายุ หรือเคยใช้ไปแล้ว ก็ตอบจบตรงนี้ทั้งหมด
     * เคสที่ "ผิด" ยิ่งต้องดักให้อยู่ เพราะรหัสที่พิมพ์ผิดไปตัวเดียวก็ยังเกือบเป็นรหัสจริง
     */
    if (event.message.type === "text") {
      const code = looksLikeCode(event.message.text);
      if (code) {
        await handleClaimAttempt(code, event, chatId);
        return;
      }
    }

    /*
     * ข้อความที่ไม่ใช่ตัวอักษร (รูป สติกเกอร์ ไฟล์) ไม่ได้ตอบ แต่ "ต้องจำ"
     * เพราะรูปที่ลูกค้าส่งเข้ามากลางบทสนทนามักเป็นสลิปโอนเงิน ซึ่งเปลี่ยนบริบททั้งห้อง
     * เดิมโค้ดตรงนี้ return ทิ้งตั้งแต่บรรทัดแรก ระบบเลยไม่มีทางรู้ว่าลูกค้าเพิ่งส่งสลิปมา
     */
    if (event.message.type !== "text") {
      const kind = event.message.type === "image" ? "image" : "other";
      conversations.remember(chatId, { role: "customer", kind });
      if (kind === "image") await handleCustomerImage(event, chatId);
      return;
    }

    conversations.remember(chatId, { role: "customer", kind: "text", text: event.message.text });
    inbox.add(chatId, { text: event.message.text.trim(), replyToken: event.replyToken, event });
  }

  /*
   * มีคนส่งอะไรที่หน้าตาเหมือนรหัส claim เข้ามา
   *
   * ข้อความตอบกลับตั้งใจให้เหมือนกันหมดสำหรับทุกกรณีที่ไม่สำเร็จ
   * ถ้าแยกว่า "รหัสหมดอายุ" กับ "ไม่มีรหัสนี้" คนที่ไล่เดาจะรู้ทันทีว่าเดาถูกแล้วหรือยัง
   *
   * ไม่มี log บรรทัดไหนในฟังก์ชันนี้ที่แตะตัวรหัส — มีแต่ผลลัพธ์
   */
  async function handleClaimAttempt(code, event, chatId) {
    const lineUserId = event.source?.userId ?? null;
    const { result } = claims.claim(code, lineUserId);

    if (result !== CLAIM.OK) {
      console.warn(`🔐 claim ไม่สำเร็จ (${result}) จากห้อง …${String(chatId).slice(-4)}`);
      await deliver(event.replyToken, [{ type: "text", text: CLAIM_FAILED_REPLY }], chatId, { remember: false });
      return;
    }

    console.log(`🔐 ยกสิทธิ์ผู้ดูแลให้ LINE user …${String(lineUserId).slice(-4)} แล้ว`);
    await deliver(event.replyToken, [{ type: "text", text: CLAIM_OK_REPLY }], chatId, { remember: false });

    /*
     * งานที่ค้างคิวไว้ตอนยังไม่มีแอดมินต้องไหลเข้ามาให้ครบ ทำทันทีหลังตอบ
     * ทำหลังตอบเพราะคิวอาจยาว ลูกค้าไม่ควรต้องรอ reply จนกว่าจะเทคิวเสร็จ
     */
    try {
      await reports?.flush();
    } catch (err) {
      logFailure("ส่งรายงานที่ค้างคิวไม่สำเร็จ", err);
    }
  }

  /*
   * ลูกค้ากดปุ่มบนการ์ดช่องทางชำระเงิน
   *
   * lineUserId ที่ใช้ตรวจเจ้าของใบเอามาจาก event.source.userId ซึ่ง LINE เป็นคนใส่มาให้
   * ไม่ใช่จาก postback data ที่ลูกค้ากดส่งมา — ถ้าเอาจาก data ใครก็ปลอมเป็นคนอื่นได้
   * ไม่มี userId (กลุ่มที่ปิดการส่ง userId) = ตรวจเจ้าของใบไม่ได้ = ไม่ออก QR ให้
   */
  async function handlePostbackEvent(event, chatId) {
    const parsed = parsePostback(event.postback?.data);
    if (!parsed) return;

    if (parsed.action === "rejected") {
      await notifyAdmin(`🚨 postback ที่พกยอดมาเอง ถูกปฏิเสธ: ${parsed.reason}`, event);
      return;
    }

    const lineUserId = event.source?.userId ?? null;
    let result;
    try {
      result = handleQrRequest({
        store,
        quoteId: parsed.quoteId,
        lineUserId,
        destId: parsed.destId,
        kind: parsed.kind,
        baseUrl,
      });
    } catch (err) {
      logFailure("ออก QR ไม่สำเร็จ", err);
      return;
    }

    /* การกดปุ่มขอ QR เป็นบริบทชำระเงินเต็มตัว — ตัวส่งการ์ดสินค้าต้องเงียบทันที */
    dispatcher.drop(chatId);
    conversations.remember(chatId, { role: "customer", kind: "text", text: `ขอ QR ${parsed.quoteId}` });

    const delivered = await deliver(event.replyToken, result.messages, chatId);
    if (result.escalate) await notifyAdmin(result.escalate, event);
    else if (!delivered) await notifyAdmin(qrNotDelivered(parsed.quoteId), event);
  }

  /*
   * ส่งของที่เกี่ยวกับเงินไม่สำเร็จต้องมีคนรู้เสมอ
   *
   * deliver() ดักและกลืน error ไว้เองเพื่อให้ log สั้น ซึ่งพอสำหรับข้อความทั่วไป
   * แต่ไม่พอสำหรับเส้นชำระเงิน: ลูกค้าเพิ่งกดปุ่มแล้วจอเงียบ เขาจะรอโดยไม่มีใครรู้
   * และเคสที่น่ากลัวที่สุดคือ LINE ปฏิเสธการ์ดทั้งใบ (เช่น action ชนิดใหม่ที่เครื่องรุ่นเก่าไม่รู้จัก)
   * ซึ่งจะพังเงียบทั้งที่โค้ดเราไม่มีอะไรผิดเลย
   */
  const qrNotDelivered = (quoteId) =>
    `⚠️ ส่ง QR ให้ลูกค้าไม่สำเร็จ (LINE ไม่รับข้อความ) รบกวนส่งช่องทางชำระเงินให้เองค่ะ ${quoteId}`;

  /*
   * ลูกค้าส่งรูปเข้ามา — รูปสลิปไม่ใช่ความสนใจสินค้า
   * ทิ้งการ์ดที่ค้างคิวของห้องนี้ทันที แล้วถ้ามีใบเสนอราคาสถานะ "ส่งลูกค้า" ค้างอยู่
   * ให้เลื่อนเป็น "รับสลิปแล้ว" และเรียกคนมาตรวจยอดจริงในแอปธนาคาร
   */
  async function handleCustomerImage(event, chatId) {
    dispatcher.drop(chatId);

    let result = null;
    try {
      result = handleSlip({ store, chatId, lineUserId: event.source?.userId ?? chatId });
    } catch (err) {
      logFailure("ตรวจสลิปไม่สำเร็จ", err);
    }
    if (!result) return;

    await deliver(event.replyToken, result.messages, chatId);
    /* สลิปมีงานรายงานของตัวเอง แยกจาก "แจ้งด่วน" เพื่อให้เจ้าของร้านกรองดูเฉพาะเรื่องเงินได้ */
    if (result.escalate) await notifyAdmin(result.escalate, event, "slip");
  }

  /*
   * ส่งข้อความหาลูกค้า + จำไว้ว่าร้านพูดอะไรไป (ใช้ย้อนบริบทตอนลูกค้าถาม "มีรูปไหม")
   *
   * remember:false ใช้กับบทสนทนาเรื่องสิทธิ์ผู้ดูแล — ทั้งฝั่งถามและฝั่งตอบต้องไม่เข้าความจำ
   * ความจำบทสนทนาถูกส่งต่อให้สมองร้านเป็นบริบท ซึ่งวิ่งออกไปนอกเครื่อง
   * เรื่องสิทธิ์ของร้านไม่มีเหตุผลอะไรที่ต้องไปอยู่ตรงนั้น
   */
  async function deliver(replyToken, messages, chatId, { remember = true } = {}) {
    try {
      await client.replyMessage({ replyToken, messages });
    } catch (err) {
      // ดักตรงนี้เอง ไม่ปล่อยขึ้นไปให้ inbox — จะได้ log แบบสั้นเหมือนทางอื่น
      logFailure("ตอบลูกค้าไม่สำเร็จ", err);
      return false;
    }
    if (remember) {
      for (const m of messages) {
        conversations.remember(chatId, { role: "shop", kind: "text", text: m.text ?? m.altText ?? "" });
      }
    }
    return true;
  }

  async function handleBatch({ chatId, texts, replyToken, event, reason }) {
    const text = combine(texts);
    if (!text) return;

    if (texts.length > 1) {
      console.log(`💬 รวม ${texts.length} บับเบิลเป็นข้อความเดียว (${reason})`);
    }

    /*
     * ── ช่องทางที่ 1: คำสั่งเจ้าของร้าน ──
     * ต้องมาก่อนทุกอย่าง และต้องเช็ค "ห้องไหนพิมพ์" ไม่ใช่แค่ "พิมพ์ว่าอะไร"
     * คำสั่งเดียวกันที่พิมพ์จากห้องลูกค้าต้องไม่มีผล ไม่งั้นลูกค้าอนุมัติส่วนลดให้ตัวเองได้
     */
    const admin = isAdminLane(event, { adminUserId, adminGroupId, claims });

    const command = parseCommand(text);
    if (command) {
      if (!admin) {
        console.warn(`🚫 คำสั่งแอดมินจากห้องที่ไม่ใช่ admin lane — ไม่มีผล: ${command.name} ${command.quoteId ?? ""}`);
        await deliver(replyToken, [{ type: "text", text: NOT_ADMIN_REPLY }], chatId);
        return;
      }
      await runAdminCommand(command, { replyToken, chatId, event });
      return;
    }

    /*
     * ── หนึ่ง LINE user มี role เดียว ──
     * ห้องที่เป็นแอดมินแล้วต้องไม่ได้คำตอบฝั่งขายอีกเลย — ไม่มีการ์ดสินค้า ไม่มีใบเสนอราคา
     * ไม่ผ่านสมองร้าน เพราะห้องนี้คือห้องที่รายงานยอดขายกับข้อมูลลูกค้าคนอื่นวิ่งเข้ามา
     * ถ้ายังตอบขายปนอยู่ด้วย เจ้าของร้านจะแยกไม่ออกว่าข้อความไหนเป็นของลูกค้าคนไหน
     * และบทสนทนาขายจะถูกเก็บปนกับรายงานภายในในความจำห้องเดียวกัน
     */
    if (admin) {
      await deliver(replyToken, [{ type: "text", text: ADMIN_ONLY_REPLY }], chatId, { remember: false });
      return;
    }

    /* ── ช่องทางที่ 2: ลูกค้ากดปุ่ม "ยืนยันสั่งซื้อ" บนการ์ดใบเสนอราคา ── */
    const confirm = text.match(CONFIRM_RE);
    if (confirm) {
      const result = handleConfirm(confirm[1], { store, chatId });
      const delivered = await deliver(replyToken, result.messages, chatId);
      if (result.escalate) await notifyAdmin(result.escalate, event);
      else if (!delivered) {
        await notifyAdmin(
          `⚠️ ส่งการ์ดช่องทางชำระเงินไม่สำเร็จ (LINE ไม่รับข้อความ) รบกวนแจ้งช่องทางให้ลูกค้าเองค่ะ ${confirm[1]}`,
          event,
        );
      }
      return;
    }

    /*
     * รูปทั้งหมดถูกสร้างไว้ล่วงหน้าแล้ว (npm run gen:images) ตรงนี้แค่หยิบจากแคช
     * เลยตอบได้ในระดับมิลลิวินาที ทันหน้าต่าง 10 วินาทีของ LINE เสมอ
     */
    const reply = buildReply(text, {
      baseUrl,
      cache: imageCache,
      /* รุ่นล่าสุดที่มีคนเอ่ยชื่อในห้องนี้ ใช้ตอบ "มีรูปไหม" ที่ไม่ได้บอกรุ่น */
      lastSlug: conversations.lastProductSlug(chatId),
    });
    let { messages, escalate } = reply;

    /*
     * การ์ดที่ประกอบมาแล้วยังส่งไม่ได้ทันที — ต้องรู้ก่อนว่ารูปยังโหลดขึ้นจริง
     * (message ชนิด image ถ้า LINE โหลดไม่ได้จะไม่ส่งให้เอง แต่การ์ด Flex ส่งสำเร็จทั้งที่รูปพัง)
     * ตรวจไม่ผ่าน = ตกไปใช้ข้อความสำรองเดิม ลูกค้าไม่เห็นกรอบเทา
     */
    if (reply.card) {
      /*
       * ตัวส่งการ์ดเพิ่งยิงใบนี้ไปเมื่อกี้ — ลูกค้าเห็นอยู่บนจอแล้ว ส่งซ้ำอีกใบไม่ได้ช่วยอะไร
       * (จังหวะที่ชนกันคือ: ลูกค้าถามราคา → คิวการ์ด → ตัวส่งการ์ดตื่นพอดี → ลูกค้าถามต่อว่า "มีรูปไหม")
       */
      if (dispatcher.sentRecently(chatId, reply.card.slug)) {
        const name = bySlug(reply.card.slug)?.name ?? "";
        messages = [{ type: "text", text: `ส่ง${name}ให้ดูด้านบนแล้วนะคะ สนใจดูรุ่นอื่นเพิ่มไหมคะ` }];
        escalate = null;
      } else if (await verifyImageUrl(reply.card.imageUrl)) {
        dispatcher.markSent(chatId, reply.card.slug); // ตอบการ์ดไปแล้ว ห้ามตัวส่งการ์ดยิงซ้ำ
        dispatcher.drop(chatId); // การ์ดที่ยังค้างคิวของห้องนี้ไม่ต้องส่งตามอีก
      } else {
        console.warn(`🖼  รูปของ ${reply.card.slug} ตรวจไม่ผ่าน — ใช้ข้อความสำรองแทน`);
        messages = [{ type: "text", text: NO_IMAGE_REPLY }];
        escalate = `รูปโหลดไม่ขึ้น ส่งการ์ดไม่ได้: ${reply.card.slug}`;
      }
    }

    /*
     * carousel ของทั้งร้าน — ตรวจรูปทุกใบพร้อมกัน ใบไหนไม่ผ่าน 200 ตัดทิ้งแล้วประกอบใหม่
     * ยิงขนานเพราะต้องทันหน้าต่างตอบของ LINE (ผลตรวจถูกแคช 6 ชม. รอบถัดไปจึงไม่เสียเวลาอีก)
     * ตัดทิ้งทีละใบดีกว่ายกเลิกทั้งก้อน — สินค้าตัวเดียวรูปพังไม่ควรทำให้ลูกค้าไม่เห็นอะไรเลย
     */
    if (reply.cards) {
      const checked = await Promise.all(
        reply.cards.map(async (c) => ((await verifyImageUrl(c.imageUrl)) ? c.slug : null)),
      );
      const ok = checked.filter(Boolean);

      if (ok.length < reply.cards.length) {
        console.warn(`🖼  รูปตรวจไม่ผ่าน ${reply.cards.length - ok.length} ใบ — ส่งเท่าที่ส่งได้`);
        const rebuilt = browseReply({ baseUrl, cache: imageCache }, ok);
        messages = rebuilt.messages;
        if (ok.length === 0) escalate = "รูปสินค้าโหลดไม่ขึ้นทั้งหมด ส่งการ์ดรวมไม่ได้";
      }
    }

    /* ── ช่องทางที่ 3: ใบเสนอราคา — คิดยอดจาก products.md เท่านั้น ── */
    if (reply.quoteRequest) {
      try {
        const result = handleQuoteRequest(reply.quoteRequest, {
          store,
          chatId,
          lineUserId: event?.source?.userId ?? chatId,
        });
        messages = result.messages;
        escalate = result.escalate;
      } catch (err) {
        // ออกใบไม่ได้ก็ยังต้องมีคนตามลูกค้าต่อ — ข้อความสำรองจาก buildReply ยังอยู่
        logFailure("ออกใบเสนอราคาไม่สำเร็จ", err);
      }
    }

    /*
     * กฎตายตัวตอบไม่ได้ → ให้สมองร้านลองตอบ (เรื่องรูปไม่มีทางมาถึงตรงนี้)
     * ตอบได้ = ลูกค้าได้คำตอบจริง ไม่ต้องรอแอดมิน · ตอบไม่ได้ = ใช้ข้อความสำรองเดิม
     *
     * ตรงนี้ทำหลังตอบ 200 ให้ LINE ไปแล้ว จึงไม่ชนหน้าต่าง 10 วินาทีของ webhook
     * ส่วน reply token ที่ใช้เป็นของบับเบิลล่าสุด อายุจึงเหลือเกือบเต็ม (~1 นาที)
     * พอสำหรับเวลาพัก 7 วิ บวกเพดาน 12 วิของ askBrain
     */
    if (reply.askBrain) {
      const answer = await askBrain(text);
      if (answer) {
        messages = [{ type: "text", text: answer }];
        escalate = null;
      }
    }

    /*
     * ใช้ replyMessage ไม่ใช่ pushMessage:
     * reply ภายใน 24 ชม.ไม่กินโควตารายเดือน ส่วน push กิน
     *
     * แจ้งแอดมินใน finally — ถ้าตอบลูกค้าไม่สำเร็จ (reply token หมดอายุ / LINE ล่ม)
     * ยิ่งต้องแจ้ง เพราะลูกค้ากำลังรอโดยไม่มีใครรู้
     */
    try {
      await deliver(replyToken, messages, chatId);
    } finally {
      if (escalate) await notifyAdmin(escalate, event);
      queueCardIntent(chatId, text, reply);
    }
  }

  /*
   * ลูกค้าเอ่ยชื่อรุ่นพร้อมท่าทีสนใจ ("สนใจบราวนี่กล่อง" / "ชิโอะปังเท่าไหร่")
   * แต่ไม่ได้ขอรูปตรง ๆ — คิวไว้ให้ตัวส่งการ์ดส่งตามในรอบถัดไป
   * ไม่ส่งทันทีเพราะลูกค้าอาจเปลี่ยนใจกลางคัน และบริบทชำระเงินอาจมาถึงระหว่างนั้น
   */
  function queueCardIntent(chatId, text, reply) {
    if (reply.card || reply.quoteRequest) return; // ได้การ์ด/ใบเสนอราคาไปแล้วในรอบนี้
    if (!wantsCard(text)) return;

    const found = matchProduct(text);
    if (!found.match) return; // กำกวมอยู่ — ถามกลับดีกว่าเดา ไม่คิวการ์ด

    if (dispatcher.queue(chatId, found.match.slug, { reason: "intent" })) {
      console.log(`🗂  คิวการ์ด ${found.match.slug} ให้ห้อง …${String(chatId).slice(-4)}`);
    }
  }

  /*
   * คำสั่งจาก admin lane — อนุมัติแล้วส่งการ์ดใบเสนอราคาให้ลูกค้าต่อทันที
   * ส่วน "ปฏิเสธ" จงใจไม่ยิงข้อความหาลูกค้าเอง ให้ทีมงานตามเอง (ดู src/admin.js)
   */
  async function runAdminCommand(command, { replyToken, chatId, event }) {
    const result = runCommand(command, { store, approver: event?.source?.userId ?? "admin" });
    if (!result) return;

    await deliver(replyToken, [{ type: "text", text: result.reply }], chatId);

    /*
     * ยิงข้อความจำลองของงานรายงานทั้ง 4 แบบ ผ่านเส้นทางส่งจริงทุกขั้น
     * (reports.submit → เช็คว่ามีแอดมินไหม → push เข้า Admin lane)
     * ไม่ได้ลัดไป push ตรง ๆ เพราะสิ่งที่ต้องพิสูจน์คือ "เส้นทาง" ไม่ใช่ "ส่งข้อความเป็นไหม"
     */
    if (result.testReports && reports) {
      for (const job of result.testReports) {
        await reports.submit(job, `[ข้อความจำลอง] ทดสอบเส้นทางส่งของงานนี้ — ระบบจริงสร้างใน MP-08`);
      }
    }

    /*
     * ยืนยันยอดแล้ว → บอกลูกค้าทันที
     * ต่างจาก "ปฏิเสธ" ที่จงใจให้คนตามเอง เพราะข่าวดีไม่ต้องมีใครมาเรียบเรียง
     * และลูกค้าที่โอนเงินไปแล้วกำลังรออยู่ว่าร้านได้รับหรือยัง
     */
    if (result.customerMessages?.length && result.quote?.chat_id) {
      try {
        await client.pushMessage({ to: result.quote.chat_id, messages: result.customerMessages });
        console.log(`💰 แจ้งลูกค้าว่ายืนยันชำระเงิน ${result.quote.quote_id} แล้ว`);
      } catch (err) {
        logFailure("แจ้งลูกค้าว่ายืนยันชำระเงินแล้วไม่สำเร็จ", err);
        await notifyAdmin(`ยืนยัน ${result.quote.quote_id} แล้ว แต่ส่งข้อความหาลูกค้าไม่สำเร็จ รบกวนแจ้งเองค่ะ`, event);
      }
    }

    if (command.name !== "approve" || !result.quote?.chat_id) return;

    const sent = sendQuote(result.quote, { store });
    try {
      await client.pushMessage({ to: result.quote.chat_id, messages: sent.messages });
      console.log(`🧾 ส่งการ์ดใบเสนอราคา ${result.quote.quote_id} ให้ลูกค้าแล้ว`);
    } catch (err) {
      logFailure("ส่งการ์ดใบเสนอราคาให้ลูกค้าไม่สำเร็จ", err);
      await notifyAdmin(`ส่งใบเสนอราคา ${result.quote.quote_id} ให้ลูกค้าไม่สำเร็จ รบกวนส่งเองค่ะ`, event);
    }
  }

  /*
   * ส่งต่อแอดมิน — ลง log เสมอ แล้วเข้าตัวส่งรายงาน (src/reports.js)
   *
   * ตัวส่งรายงานเป็นคนตัดสินว่าจะถึงมือแอดมินเลย หรือเก็บเข้าคิวไว้ก่อน
   * ตอนที่ยังไม่มีใคร claim สิทธิ์ ระบบไม่รู้ว่าห้องไหนเป็นห้องเจ้าของร้าน
   * และห้องที่ดูเหมือนห้องเจ้าของอาจเป็นห้องที่เจ้าของทดสอบตัวเองเป็นลูกค้าอยู่
   * จึงต้องเงียบไว้ก่อน (deliver=local) แล้วค่อยเทคิวให้ตอน claim สำเร็จ
   */
  async function notifyAdmin(reason, event, job = "urgent") {
    const userId = event?.source?.userId ?? "unknown";
    // log ตัดไอดีเหลือ 8 ตัวพอให้ไล่หาแชทได้ ไม่ต้องเก็บไอดีลูกค้าเต็ม ๆ ไว้ในไฟล์ log
    console.warn(`🔔 ส่งต่อแอดมิน: ${reason} (user ${String(userId).slice(0, 8)}…)`);

    if (!reports) return;
    try {
      await reports.submit(job, `${reason}\nuserId: ${userId}`);
    } catch (err) {
      // แจ้งแอดมินไม่สำเร็จก็ไม่ควรทำให้ลูกค้าได้ error — ลูกค้าได้ข้อความไปแล้ว
      console.error("ส่งรายงานให้แอดมินไม่สำเร็จ:", err instanceof HTTPFetchError ? err.status : err.message);
    }
  }

  return { handleEvent, handleBatch, inPaymentContext, pushProductCard, notifyAdmin };
}
