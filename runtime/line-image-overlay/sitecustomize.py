# hermes-bakery — ส่งรูปจริงบน LINE ได้ (ร้านขนมปัง สดสดสด)
#
# โหลดอัตโนมัติโดย `site` ของ CPython เพราะ PYTHONPATH ชี้มาที่ mount แบบ read-only
# ที่เก็บไฟล์นี้ ไม่ได้แก้ไฟล์ต้นทางสักบรรทัด — ห่อฟังก์ชันเดียวไว้ในหน่วยความจำ
# เฉพาะใน process ของ gateway และเฉพาะตอนที่ checksum ต้นทางยังตรงกับที่รีวิวไว้
#
# ที่ห่อ:
#   gateway.platforms.base.BasePlatformAdapter._send_with_retry
#
# ทำไมต้องเป็นจุดนี้ ไม่ใช่ LINE adapter ตรง ๆ:
#   plugin loader import ตัว LINE adapter ด้วยชื่อโมดูลส่วนตัว
#   (`hermes_plugins.line_platform.adapter`) ซึ่ง meta-path hook มองไม่เห็น
#   แต่ข้อความขาออกทุกข้อความของทุกแพลตฟอร์มวิ่งผ่าน _send_with_retry
#   และ `self` ตรงนั้นคือตัว adapter จริง จึงเรียก send_image_file ได้
#
# ปัญหาที่แก้:
#   บอทตอบ "รูปพนักงานอยู่ที่นี่ค่ะ: /images/staff.jpg" แทนที่จะส่งรูป
#   เพราะฝั่ง LINE ของ Hermes ส่งออกได้แต่ text — โมเดลเลยด้นสดเป็น path
#
# วิธีใช้ (ฝั่งสมองร้านเขียนแค่นี้):
#   [[IMG:staff]]  →  ระบบส่งรูป /opt/data/images/staff.jpg เป็นรูปจริง
#
# Fail closed ทุกทาง: checksum ไม่ตรง / import พลาด / ไฟล์รูปหาย / ส่งรูปไม่สำเร็จ
# → ระบบกลับไปเป็น stock และลูกค้าได้ข้อความสุภาพ ไม่มี path หลุดออกไปเด็ดขาด

import functools
import hashlib
import importlib.abc
import importlib.machinery
import os
import re
import sys

TAG = "BAKERY_IMAGE"
IMAGE_DIR = os.environ.get("BAKERY_IMAGE_DIR", "/opt/data/images")
ALLOWED_EXTS = (".jpg", ".jpeg", ".png")

# ข้อความตอนส่งรูปไม่ได้ — ตรงกับกติกาใน context.md (ลงท้าย ค่ะ ไม่มีศัพท์เทคนิค)
FALLBACK_TEXT = "เดี๋ยวแจ้งแอดมินส่งรูปให้นะคะ รอสักครู่ค่ะ"

# แท็กที่สมองร้านใช้สั่งส่งรูป — slug เท่านั้น ไม่ใช่ path
# จงใจไม่ให้สมองร้านเขียน path จริง เพื่อไม่ให้มี path ให้หลุดตั้งแต่แรก
_IMG_TAG = re.compile(r"\[\[IMG:\s*([A-Za-z0-9_-]{1,64})\s*\]\]")

# กันตกชั้นสุดท้าย: ถ้าโมเดลยังด้นสดเป็น path หรือ URL รูปมาในเนื้อข้อความ
# ให้ลบทิ้งก่อนถึงลูกค้าเสมอ — นี่คืออาการเดิมที่เคยหลุดไปหาลูกค้าจริง
_LEAKED_PATH = re.compile(
    r"(?:https?://\S+?)?/(?:opt/data/)?images/[A-Za-z0-9_.-]+\.(?:jpe?g|png)\b"
    r"|MEDIA:\S+"
    r"|\[\[IMG:[^\]]*\]\]",
    re.IGNORECASE,
)

UPSTREAM = {
    "gateway.platforms.base": (
        "/opt/hermes/gateway/platforms/base.py",
        "d7fbcba483173fbd66af1aa6f82ac65f1b67e2290b44b12da8e2b6e3d7650fc5",
    ),
}


def _log(*parts):
    try:
        print(TAG, *parts, file=sys.stderr, flush=True)
    except Exception:
        pass


def _sha256(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def _resolve_slug(slug):
    """slug -> path จริงบนดิสก์ หรือ None

    รับเฉพาะ [A-Za-z0-9_-] จาก regex อยู่แล้ว จึงไม่มี / หรือ .. ให้ไต่ออกนอกโฟลเดอร์
    แต่ยัง realpath เทียบซ้ำอีกชั้น เผื่อ symlink ชี้ออกนอก IMAGE_DIR
    """
    base = os.path.realpath(IMAGE_DIR)
    for ext in ALLOWED_EXTS:
        candidate = os.path.realpath(os.path.join(base, slug + ext))
        if not candidate.startswith(base + os.sep):
            continue
        if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
            return candidate
    return None


def _clean_text(text):
    """ตัดแท็กและ path ที่หลุดออกจากข้อความที่จะถึงลูกค้า"""
    cleaned = _LEAKED_PATH.sub("", text)
    # เก็บกวาดร่องรอยที่เหลือ เช่น "รูปอยู่ที่นี่ค่ะ:" ที่ห้อยท้ายโดยไม่มีอะไรตาม
    cleaned = re.sub(r"[ \t]*[:：]\s*(?=\n|$)", "", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _patch_platform_base(module):
    adapter_cls = module.BasePlatformAdapter
    original_send = adapter_cls._send_with_retry

    @functools.wraps(original_send)
    async def send_with_images(self, chat_id, content, *args, **kwargs):
        text = str(content or "")

        slugs = _IMG_TAG.findall(text)
        if not slugs:
            # ไม่มีแท็กรูป — ยังต้องกวาด path ที่โมเดลอาจด้นสดออกก่อนส่ง
            safe = _clean_text(text)
            if safe != text.strip():
                _log("STRIPPED_LEAKED_PATH")
                if not safe:
                    safe = FALLBACK_TEXT
                return await original_send(self, chat_id, safe, *args, **kwargs)
            return await original_send(self, chat_id, content, *args, **kwargs)

        caption = _clean_text(text)

        # แพลตฟอร์มที่ส่งรูปไม่ได้ (หรือ adapter ไม่มีเมธอดนี้) → ตกไปทางข้อความล้วน
        send_image = getattr(self, "send_image_file", None)
        if send_image is None:
            _log("NO_IMAGE_SUPPORT", type(self).__name__)
            return await original_send(self, chat_id, caption or FALLBACK_TEXT, *args, **kwargs)

        paths = []
        for slug in slugs:
            path = _resolve_slug(slug)
            if path is None:
                _log("IMAGE_MISSING", slug)
                continue
            if path not in paths:
                paths.append(path)

        if not paths:
            # ขอรูปมาแต่ไม่มีไฟล์เลย — ห้ามส่งข้อความเปล่า ๆ ที่อ่านไม่รู้เรื่อง
            return await original_send(self, chat_id, caption or FALLBACK_TEXT, *args, **kwargs)

        # ใบแรกแนบ caption ไปด้วยในคอลเดียว → ใช้ reply token ครั้งเดียว
        # ไม่กิน push quota รายเดือน (ต่างจากการยิงรูปกับข้อความแยกกัน)
        result = None
        try:
            result = await send_image(chat_id, paths[0], caption or None)
            for extra in paths[1:]:
                await send_image(chat_id, extra)
        except Exception as exc:
            _log("IMAGE_SEND_RAISED", repr(exc)[:200])
            result = None

        if result is not None and getattr(result, "success", False):
            _log("IMAGE_SENT", os.path.basename(paths[0]), "n=%d" % len(paths))
            return result

        _log("IMAGE_SEND_FAILED", getattr(result, "error", "unknown"))
        return await original_send(self, chat_id, caption or FALLBACK_TEXT, *args, **kwargs)

    adapter_cls._send_with_retry = send_with_images
    _log("PATCHED", "BasePlatformAdapter._send_with_retry")


PATCHERS = {"gateway.platforms.base": _patch_platform_base}


class _Hook(importlib.abc.MetaPathFinder):
    """รอให้โมดูลเป้าหมายถูก import แล้วค่อยห่อ — ไม่บังคับ import เอง"""

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in PATCHERS or fullname in sys.modules:
            return None

        expected_path, expected_hash = UPSTREAM[fullname]
        actual = _sha256(expected_path)
        if actual != expected_hash:
            # ต้นทางเปลี่ยนไปจากที่รีวิวไว้ → ไม่แตะอะไรเลย ปล่อยเป็น stock
            _log("CHECKSUM_MISMATCH", fullname, "overlay disabled")
            PATCHERS.pop(fullname, None)
            return None

        sys.meta_path.remove(self)
        try:
            module = importlib.import_module(fullname)
            PATCHERS.pop(fullname)(module)
        except Exception as exc:
            _log("PATCH_FAILED", fullname, repr(exc)[:200])
        finally:
            if PATCHERS and self not in sys.meta_path:
                sys.meta_path.insert(0, self)
        return None


sys.meta_path.insert(0, _Hook())
_log("LOADED", "image_dir=%s" % IMAGE_DIR)
