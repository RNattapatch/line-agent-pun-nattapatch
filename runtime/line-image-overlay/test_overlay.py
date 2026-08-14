"""เทสต์ overlay ก่อนขึ้น production — จำลอง adapter ของ LINE ขึ้นมาเอง"""
import asyncio
import importlib.util
import os
import shutil
import sys
import tempfile

WORK = tempfile.mkdtemp()
IMG_DIR = os.path.join(WORK, "images")
os.makedirs(IMG_DIR)
# ไฟล์รูปปลอม ขอแค่มีจริงและไม่ว่าง
with open(os.path.join(IMG_DIR, "staff.jpg"), "wb") as f:
    f.write(b"\xff\xd8\xff" + b"0" * 500)

os.environ["BAKERY_IMAGE_DIR"] = IMG_DIR

spec = importlib.util.spec_from_file_location(
    "bakery_overlay", os.path.join(os.path.dirname(__file__), "sitecustomize.py")
)
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class SendResult:
    def __init__(self, success=True, error=None):
        self.success = success
        self.error = error


class FakeModule:
    pass


sent = []


class BasePlatformAdapter:
    async def _send_with_retry(self, chat_id, content, *a, **kw):
        sent.append(("text", content))
        return SendResult(True)


class LineAdapter(BasePlatformAdapter):
    image_ok = True

    async def send_image_file(self, chat_id, path, caption=None, metadata=None):
        if not self.image_ok:
            return SendResult(False, "line refused")
        sent.append(("image", os.path.basename(path), caption))
        return SendResult(True)


class TextOnlyAdapter(BasePlatformAdapter):
    pass


mod = FakeModule()
mod.BasePlatformAdapter = BasePlatformAdapter
overlay._patch_platform_base(mod)

FAIL = []


def check(name, cond, detail=""):
    print(("  ok  " if cond else " FAIL ") + name + (f"  {detail}" if detail and not cond else ""))
    if not cond:
        FAIL.append(name)


async def run(adapter, text):
    sent.clear()
    await adapter._send_with_retry("U123", text)
    return list(sent)


async def main():
    line = LineAdapter()

    out = await run(line, "นี่คือพนักงานประจำร้านของเราค่ะ [[IMG:staff]]")
    check("มีแท็ก + ไฟล์อยู่ → ส่งรูปพร้อม caption ครั้งเดียว",
          len(out) == 1 and out[0][0] == "image" and out[0][1] == "staff.jpg", str(out))
    check("caption ไม่มีแท็กหลงเหลือ",
          out and "[[IMG" not in (out[0][2] or ""), str(out))

    out = await run(line, "[[IMG:staff]]")
    check("แท็กอย่างเดียว ไม่มีข้อความ → ส่งรูป caption ว่าง",
          len(out) == 1 and out[0][0] == "image" and out[0][2] is None, str(out))

    out = await run(line, "ขอรูปนะคะ [[IMG:ไม่มีไฟล์นี้]]")
    check("slug ที่ไม่ match regex → ถือว่าไม่มีแท็ก แต่ต้องกวาดทิ้ง",
          len(out) == 1 and out[0][0] == "text" and "[[IMG" not in out[0][1], str(out))

    out = await run(line, "ดูรูปนี้ค่ะ [[IMG:missing]]")
    check("แท็กถูกแต่ไม่มีไฟล์ → ส่งข้อความ ไม่มีแท็กติดไป",
          len(out) == 1 and out[0][0] == "text" and "[[IMG" not in out[0][1], str(out))

    line.image_ok = False
    out = await run(line, "พนักงานค่ะ [[IMG:staff]]")
    check("LINE ปฏิเสธรูป → ตกไปข้อความ ไม่ระเบิด",
          len(out) == 1 and out[0][0] == "text", str(out))
    line.image_ok = True

    out = await run(TextOnlyAdapter(), "พนักงานค่ะ [[IMG:staff]]")
    check("adapter ที่ส่งรูปไม่ได้ → ข้อความล้วน ไม่มีแท็ก",
          len(out) == 1 and out[0][0] == "text" and "[[IMG" not in out[0][1], str(out))

    # อาการเดิมที่หลุดไปหาลูกค้าจริง
    for leak in [
        "รูปพนักงานอยู่ที่นี่ค่ะ: /images/staff.jpg",
        "ดูได้ที่ /opt/data/images/staff.jpg ค่ะ",
        "MEDIA:/opt/data/images/staff.jpg",
        "รูปอยู่ที่ https://example.com/images/staff.jpg ค่ะ",
    ]:
        out = await run(line, leak)
        body = out[0][1] if out else ""
        check(f"กวาด path ที่หลุด: {leak[:32]}…",
              len(out) == 1 and out[0][0] == "text"
              and ".jpg" not in body and "/images/" not in body and "MEDIA:" not in body,
              str(out))

    out = await run(line, "/images/staff.jpg")
    check("เหลือแต่ path ล้วน → ต้องได้ข้อความสำรอง ไม่ใช่ข้อความว่าง",
          len(out) == 1 and out[0][1] == overlay.FALLBACK_TEXT, str(out))

    out = await run(line, "สวัสดีค่ะ ร้านขนมปัง สดสดสด ยินดีให้บริการค่ะ")
    check("ข้อความปกติ → ผ่านตรง ไม่ถูกแก้",
          len(out) == 1 and out[0][1] == "สวัสดีค่ะ ร้านขนมปัง สดสดสด ยินดีให้บริการค่ะ", str(out))

    out = await run(line, "บราวนี่กล่อง 189 บาทค่ะ")
    check("ข้อความมีตัวเลข/ราคา → ไม่โดนกวาด",
          len(out) == 1 and out[0][1] == "บราวนี่กล่อง 189 บาทค่ะ", str(out))

    # path traversal
    out = await run(line, "[[IMG:staff]] ok")
    check("resolve slug ปกติได้", len(out) == 1 and out[0][0] == "image", str(out))
    check("traversal กันได้ (../ ไม่ผ่าน regex)", overlay._resolve_slug("..") is None)


asyncio.run(main())
shutil.rmtree(WORK, ignore_errors=True)
print()
if FAIL:
    print(f"❌ ตก {len(FAIL)} ข้อ: {FAIL}")
    sys.exit(1)
print("✅ ผ่านทั้งหมด")
