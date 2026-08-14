# LINE image overlay — ทำให้บอทส่งรูปได้จริง

โค้ดที่รันอยู่บน VPS (`/docker/hermes-bakery`) ไม่ใช่ `src/server.js` ในโปรเจกต์นี้
บอทที่รับลูกค้าจริงคือ **Hermes Agent** ซึ่งอ่านสมองร้าน (`context.md` + `products.md` +
`promotions.md`) จาก repo นี้ผ่าน cron ทุก 5 นาที

ฝั่ง LINE ของ Hermes **ส่งออกได้แต่ข้อความ** พอสมองร้านสั่งว่า "ส่งรูป" แล้วทำไม่ได้
โมเดลจึงด้นสดออกมาเป็น path ให้ลูกค้าเห็น:

> รูปพนักงานอยู่ที่นี่ค่ะ: /images/staff.jpg

ไฟล์ในโฟลเดอร์นี้คือส่วนที่ทำให้ส่งรูปได้จริง — เก็บไว้ใน repo เพื่อให้มีเวอร์ชันคุม
ตัวที่ทำงานจริงคือสำเนาบน VPS ที่ `/docker/hermes-bakery/data/overlay/`

| ไฟล์ | หน้าที่ |
|---|---|
| `sitecustomize.py` | overlay ที่แปลงแท็ก `[[IMG:slug]]` เป็น LINE image message |
| `test_overlay.py` | เทสต์ 16 ข้อ รันได้ทั้งบนเครื่องและในคอนเทนเนอร์จริง |

## วิธีทำงาน

สมองร้านเขียนแค่แท็กสั้น ๆ ไม่ต้องรู้จัก path:

```
[[IMG:staff]] นี่คือพนักงานประจำร้านของเราค่ะ ดูแลหน้าร้านทุกวันเลยค่ะ
```

overlay ห่อ `BasePlatformAdapter._send_with_retry` แล้วแปลงเป็น `send_image_file()`
ซึ่งเสิร์ฟไฟล์ผ่าน `/line/media/<token>/` ที่ traefik route ไว้อยู่แล้ว
ข้อความที่เหลือกลายเป็นคำบรรยายใต้รูป ส่งไปพร้อมกันในคอลเดียว —
ใช้ reply token ครั้งเดียว **ไม่กินโควตา push รายเดือน**

ที่ต้องห่อ `BasePlatformAdapter` ไม่ใช่ LINE adapter ตรง ๆ เพราะ plugin loader
import ตัว LINE adapter ด้วยชื่อโมดูลส่วนตัวที่ meta-path hook มองไม่เห็น
แต่ข้อความขาออกทุกข้อความวิ่งผ่าน `_send_with_retry` และ `self` ตรงนั้นคือ adapter จริง

## ทำไมเป็น slug ไม่ใช่ path

ถ้าให้สมองร้านเขียน path เอง วันไหน overlay ไม่ทำงาน path จะหลุดถึงลูกค้าทันที
สมองร้านเลยรู้จักแค่ชื่อสั้น ๆ — **ไม่มี path ให้หลุดตั้งแต่ต้นทาง**

และ overlay ยัง **กวาด path/URL รูปออกจากข้อความเสมอ** แม้ตอนที่ไม่มีแท็ก
ต่อให้โมเดลด้นสดขึ้นมาใหม่ บั๊กเดิมก็เกิดซ้ำไม่ได้

## Fail closed

checksum ของ `base.py` ไม่ตรงกับที่รีวิวไว้ / ไฟล์รูปหาย / LINE ปฏิเสธรูป
→ ระบบกลับไปเป็น stock และลูกค้าได้ข้อความสุภาพ ไม่มีศัพท์เทคนิคหรือ path หลุด

## รันเทสต์

```bash
python3 runtime/line-image-overlay/test_overlay.py
```

บนคอนเทนเนอร์จริง:

```bash
ssh root@srv1840715.hstgr.cloud 'docker exec hermes-bakery-hermes-bakery-1 bash -lc "cd /tmp && python3 /opt/bakery-overlay/test_overlay.py"'
```

## เพิ่มรูปใหม่

วางไฟล์ใน `public/images/<slug>.jpg` แล้ว push — brain-sync จะ rsync ขึ้น VPS ให้เอง
ภายใน 5 นาที จากนั้นเพิ่ม `<slug>` ลงตารางใน [`context.md`](../../context.md) ข้อ 6
