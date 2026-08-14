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
cp .env.example .env      # แล้วเติม CHANNEL_ACCESS_TOKEN กับ CHANNEL_SECRET
npm start
```

ตั้ง Webhook URL ใน LINE Developers Console ให้ชี้มาที่ `https://<โดเมนของคุณ>/webhook`
แล้วเปิด **Use webhook** ส่วนตอนพัฒนาใช้ `ngrok http 3000` เปิด tunnel ได้

| endpoint | ใช้ทำอะไร |
|---|---|
| `POST /webhook` | รับ event จาก LINE (ตรวจลายเซ็นทุกคำขอ) |
| `GET /healthz` | health check |

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

## แก้ให้เป็นบอทของร้านจริง

ตรรกะการตอบอยู่ที่ฟังก์ชัน `buildReply()` ใน [`src/server.js`](src/server.js) ตอนนี้เป็นแค่ตัวอย่าง
(ทักทาย + echo) เปลี่ยนตรงนั้นให้เป็นเมนู ราคา หรือต่อฐานข้อมูลสต็อกได้เลย
