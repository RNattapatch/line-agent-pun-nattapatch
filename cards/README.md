# cards/ — template การ์ดและคีย์เวิร์ด

โฟลเดอร์นี้เก็บได้ **แค่ 2 อย่าง**:

1. `templates/*.json` — โครงการ์ด LINE Flex ที่มี `{{placeholder}}` ให้โค้ดเติมค่า
2. `keywords.json` — คำที่ใช้จับ intent ของลูกค้า และคำที่สั่งให้ตัวส่งการ์ดเงียบ

## ห้ามเก็บอะไรที่นี่

- ❌ userId / displayName / เบอร์โทร / ที่อยู่ของลูกค้า
- ❌ ใบเสนอราคาจริง ยอดจริง `quote_id` จริง
- ❌ รูปสลิป รูปที่ลูกค้าส่งเข้ามา

repo นี้เป็น **public** ธุรกรรมจริงทั้งหมดอยู่บน VPS ที่ `~/shop-data/quotes/` เท่านั้น
(โหมด 700 สำหรับโฟลเดอร์ · 600 สำหรับไฟล์) ดู [`src/quotes.js`](../src/quotes.js)

## placeholder ที่ template รู้จัก

| ไฟล์ | placeholder |
|---|---|
| `product-card.json` | `{{name}}` `{{price}}` `{{image_url}}` |
| `quote-card.json` | `{{quote_id}}` `{{items}}` `{{totals}}` `{{expires_at}}` |

`{{items}}` กับ `{{totals}}` เป็น placeholder แบบ **อาร์เรย์** — โค้ดแทนที่ด้วย
รายการ Flex component ทั้งก้อน ไม่ใช่ข้อความ

## ราคาบนการ์ดมาจากไหน

มาจากตารางใน [`products.md`](../products.md) เสมอ ผ่าน [`src/price-source.js`](../src/price-source.js)
**ห้ามพิมพ์ราคาลงใน template** เพราะจะกลายเป็นแหล่งราคาที่สอง

## รูปบนการ์ด

ต้องเป็นลิงก์ถาวรและตอบ HTTP 200 เท่านั้น — ตรวจด้วย

```bash
npm run check:cards
```

โฮสต์ชั่วคราว (`tempfile.*`, ngrok, localhost, `http://`) ถูกปฏิเสธในโค้ด
ดู [`src/image-verify.js`](../src/image-verify.js)
