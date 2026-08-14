# line-agent

บอท LINE Official Account ของร้าน — รับ webhook จาก LINE แล้วตอบลูกค้าอัตโนมัติ

> ⚠️ **repo นี้เป็น public** อย่า commit `.env`, channel access token, channel secret
> หรือ user ID ของลูกค้าลงมาเด็ดขาด `.gitignore` กันไว้ให้ระดับหนึ่งแล้ว แต่ยังต้องระวังเอง

## สถาปัตยกรรม: Builder กับ Worker แยกกัน

ระบบนี้แบ่งเป็นสองฝั่ง **โดยตั้งใจ** อย่าเอามารวมกัน

| | **Builder** | **Worker** (repo นี้) |
|---|---|---|
| คืออะไร | Claude Code บนเครื่องผู้พัฒนา | เซิร์ฟเวอร์บอทหน้าร้าน |
| ทำอะไร | สั่งส่งข้อความเอง ทดสอบ ดูโควตา | รับ webhook แล้วตอบลูกค้า |
| เครื่องมือ | `@line/line-bot-mcp-server` (MCP) | `@line/bot-sdk` (repo นี้) |
| ความลับอยู่ไหน | `~/.line-builder/.env` (นอก repo) | `.env` บนเซิร์ฟเวอร์ (gitignore) |
| อยู่ใน repo นี้ไหม | **ไม่** | ใช่ |

**ทำไมต้องแยก:** เซิร์ฟเวอร์หน้าร้านเปิดรับทราฟฟิกจากอินเทอร์เน็ต ความเสี่ยงโดนเจาะสูงกว่าเครื่องผู้พัฒนามาก
ถ้าใช้ token ใบเดียวกันแล้วเซิร์ฟเวอร์หลุด คนร้ายจะยิงข้อความหาลูกค้าทุกคนในนาม OA ได้ทันที
เลยต้อง **ออก token คนละใบ** ทั้งสองฝั่ง จะได้ revoke แยกกันได้โดยอีกฝั่งไม่ดับตาม

## เริ่มใช้งาน

```bash
npm install
cp .env.example .env      # แล้วเติม CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, PUBLIC_BASE_URL
npm run gen:images        # สร้างรูปสินค้าครั้งเดียว (ต้องมี KIE_API_KEY)
npm start
```

ตั้ง Webhook URL ใน LINE Developers Console ให้ชี้มาที่ `https://<โดเมนของคุณ>/webhook`
แล้วเปิด **Use webhook** ส่วนตอนพัฒนาใช้ `ngrok http 3000` เปิด tunnel ได้

| endpoint | ใช้ทำอะไร |
|---|---|
| `POST /webhook` | รับ event จาก LINE (ตรวจลายเซ็นทุกคำขอ) |
| `GET /healthz` | health check |
| `GET /images/*` | รูปสินค้าที่ LINE มาโหลดไปแสดงให้ลูกค้า |

รันเทสต์: `npm test` (ใช้ `node --test` ที่มากับ Node ไม่ต้องลง framework เพิ่ม)

## ความปลอดภัยที่ทำไว้แล้ว

- **ตรวจลายเซ็นทุกคำขอ** ด้วย `middleware()` ของ SDK ถ้า header `x-line-signature`
  ไม่ตรงกับ HMAC-SHA256 ของ body จะตอบ **401** ทิ้งทันที กันคนยิง endpoint มั่ว ๆ
- **ตอบ 200 ก่อนแล้วค่อยประมวลผล** LINE รอแค่ 10 วินาที ถ้าช้าจะ retry ซ้ำ
- **ใช้ `replyMessage` ไม่ใช่ `pushMessage`** การตอบกลับภายใน 24 ชม.**ไม่กินโควตารายเดือน**
  ส่วน push กินโควตา จุดนี้มีผลกับค่าใช้จ่ายโดยตรง
- **error handler ไม่พ่น stack trace** ออกไปหาผู้เรียก

## เช็คโควตาข้อความคงเหลือ

โควตานับเฉพาะ push/broadcast — reply ภายใน 24 ชม.ไม่นับ และรีเซ็ตทุกต้นเดือน

```bash
curl -H "Authorization: Bearer $CHANNEL_ACCESS_TOKEN" https://api.line.me/v2/bot/message/quota
curl -H "Authorization: Bearer $CHANNEL_ACCESS_TOKEN" https://api.line.me/v2/bot/message/quota/consumption
```

ดูในหน้าเว็บก็ได้ที่ LINE Official Account Manager > ภาพรวม

## รูปสินค้า

ลูกค้าพิมพ์ว่า *"ขอดูรูปชิโอะปังหน่อย"* แล้วบอทส่งรูปกลับไปได้เลย
รูปมาจาก kie.ai แต่ **สร้างไว้ล่วงหน้า** ไม่ได้สร้างตอนลูกค้าทัก

### ทำไมต้องสร้างล่วงหน้า

| | สร้างตอนลูกค้าทัก | สร้างล่วงหน้า (ที่ใช้อยู่) |
|---|---|---|
| เวลาที่ใช้ | ~50 วินาที/ใบ | อ่านจากดิสก์ ไม่ถึงมิลลิวินาที |
| ทันหน้าต่าง 10 วินาทีของ LINE ไหม | **ไม่ทัน** LINE จะ retry ซ้ำ | ทัน |
| ต้องใช้ `pushMessage` ไหม | ต้อง = **กินโควตารายเดือน** | ไม่ต้อง ใช้ `replyMessage` ที่ฟรี |
| ค่า gen | จ่ายใหม่ทุกครั้งที่มีคนถาม | จ่ายครั้งเดียว 4 ใบ = 16 เครดิต |

### วิธีสร้าง / เปลี่ยนรูป

```bash
npm run gen:images                          # สร้างเฉพาะตัวที่ยังไม่มีรูป (รันซ้ำได้ ไม่เสียเงินซ้ำ)
npm run gen:images -- --list                # ดูว่าตัวไหนมีรูปแล้วบ้าง
npm run gen:images -- --only brownie-box    # สร้างใหม่เฉพาะตัวนี้ (เช่น ไม่ชอบรูปเดิม)
npm run gen:images -- --force               # สร้างใหม่ทั้ง 4 ใบ ทับของเดิม
```

**อยากได้รูปหน้าตาอื่น** — แก้ช่อง `prompt` ของสินค้านั้นใน [`src/products.js`](src/products.js)
แล้วรัน `--only <slug>` ใหม่ · โจทย์กลาง (`STYLE`) คุมให้ทุกใบเป็นชุดเดียวกัน:
แสงธรรมชาตินุ่ม พื้นไม้โอ๊คโทนอุ่น ฉากหลังเรียบ จัตุรัส 1:1 และห้ามมีตัวหนังสือ/โลโก้/มือคนในรูป

หลัง gen เสร็จ **ต้องรีสตาร์ตเซิร์ฟเวอร์** เพราะบอทอ่านแคชรูปตอนบูตครั้งเดียว

### ของที่ commit ขึ้น repo ได้

`public/images/*.jpg` กับ `image-cache.json` **commit ได้** ไม่ใช่ความลับ
`image-cache.json` เก็บแค่ path (`/images/shio-pan.jpg`) ไม่ได้เก็บโดเมน
โดเมนมาจาก `PUBLIC_BASE_URL` ตอนรัน จะได้ย้าย host หรือสลับ ngrok โดยไม่ต้องแก้ไฟล์

### ข้อกำหนดฝั่ง LINE ที่โค้ดบังคับไว้ให้แล้ว

- ส่งเป็น message type `image` ที่มีทั้ง `originalContentUrl` และ `previewImageUrl`
- URL ต้องเป็น HTTPS (TLS 1.2+) — ถ้า `PUBLIC_BASE_URL` ไม่ใช่ `https://` บอทจะไม่ส่งรูป
  แต่ตอบข้อความสำรองแทน ดีกว่าให้ลูกค้าเห็นรูปพัง
- URL ที่ kie.ai คืนมาอยู่บนโดเมน `tempfile.*` และหมดอายุราว 24 ชม.
  script เลย **ดาวน์โหลดมาเก็บเอง** แล้วเสิร์ฟจาก `/images/` ของเซิร์ฟเวอร์นี้
- ไฟล์ต้องเป็น JPEG/PNG และ preview ต้องไม่เกิน 1 MB — script เช็คให้ทั้งสองข้อ
  ถ้าใบไหนได้ไฟล์เกิน 1 MB จะสั่งสร้างใหม่ให้เองสูงสุด 3 ครั้ง

### ถ้ารูปไม่มี / kie.ai ล่ม

ลูกค้าจะได้ข้อความเดียวเสมอ ตามที่ [`context.md`](context.md) ข้อ 6 กำหนด:

> รุ่นนี้ยังไม่มีรูปในระบบค่ะ เดี๋ยวแจ้งแอดมินส่งรูปให้นะคะ

แล้วขึ้น log ฝั่งเซิร์ฟเวอร์ให้แอดมินตามต่อ (ถ้าตั้ง `ADMIN_USER_ID` ไว้จะ push แจ้งแอดมินด้วย)
**ไม่มีทาง**ที่ลูกค้าจะได้ยินคำว่า AI / บอท / "สร้างรูปไม่ได้" หรือเห็น error ทางเทคนิค — มีเทสต์กวาดคำต้องห้ามไว้ใน [`tests/reply.test.js`](tests/reply.test.js)

### kie.ai ที่ยืนยันกับ API จริงแล้ว (2026-08-14)

| เรื่อง | ค่าจริง |
|---|---|
| สร้าง task | `POST https://api.kie.ai/api/v1/jobs/createTask` |
| เช็คสถานะ | `GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...` |
| auth | `Authorization: Bearer $KIE_API_KEY` |
| โมเดล | `google/nano-banana` (1:1, jpeg) |
| ผลลัพธ์ | `data.resultJson` เป็น string → parse แล้วอ่าน `resultUrls[0]` |
| อายุ URL | ชั่วคราว ~24 ชม. → ต้องโหลดมาเก็บเอง |
| ราคา | **4 เครดิต/รูป** (เช็คจาก `creditsConsumed` และยอดคงเหลือที่ลดลงจริง) |
| rate limit | 20 คำขอใหม่/10 วินาที · เกินแล้วได้ 429 |
| เวลา gen | ~50 วินาที/ใบ ← เหตุผลที่ต้อง pre-generate |

⚠️ `KIE_API_KEY` ใช้เฉพาะตอนรัน `npm run gen:images` เท่านั้น
ตัวบอทที่รับทราฟฟิกจากอินเทอร์เน็ตไม่ต้องมี key นี้ — จะได้ไม่มีอะไรให้หลุดถ้าเซิร์ฟเวอร์โดนเจาะ

## แก้ให้เป็นบอทของร้านจริง

ตรรกะการตอบอยู่ที่ [`src/reply.js`](src/reply.js) — `buildReply()` คืนข้อความในรูปแบบของ LINE
พร้อมธง `escalate` บอกว่าเคสนี้ต้องส่งต่อแอดมินไหม

| ไฟล์ | หน้าที่ |
|---|---|
| [`src/reply.js`](src/reply.js) | ตัดสินใจว่าจะตอบอะไร (จุดที่แก้บ่อยที่สุด) |
| [`src/products.js`](src/products.js) | รายการสินค้า + คำที่ลูกค้าใช้เรียก + โจทย์รูป |
| [`src/image-cache.js`](src/image-cache.js) | อ่านแคชรูป + ประกอบ URL |
| [`src/kie.js`](src/kie.js) | คุยกับ kie.ai (ใช้เฉพาะตอน gen) |
| [`scripts/gen-images.mjs`](scripts/gen-images.mjs) | script สร้างรูปล่วงหน้า |

ราคายึดตาม [`products.md`](products.md) เสมอ — `src/products.js` ก๊อปตัวเลขมาใช้ตอนตอบ
และมีเทสต์เทียบสองไฟล์นี้ทุกครั้งที่รัน `npm test` แก้ราคาในไฟล์เดียวแล้วลืมอีกไฟล์ เทสต์จะแดง
