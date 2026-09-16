/*
 * เทสต์ตัวสร้าง QR — ภาพนี้คือสิ่งที่ลูกค้าเอามือถือไปสแกนแล้วกดโอนเงินจริง
 * ผิดที่นี่ = เงินไปผิดที่หรือผิดยอด เอาคืนไม่ได้ เทสต์จึงไม่ยอมเชื่อตัวเข้ารหัสของเราเอง
 *
 * ═══ วิธีตรวจ: ถอดกลับด้วยโค้ดคนละชุด ═══
 * ไฟล์นี้เขียน "ตัวถอดรหัส" ขึ้นมาใหม่จากสเปก ไม่ได้เรียกฟังก์ชันใน src/qr-encode.js เลย
 * แล้วเอาไปอ่านตารางที่ตัวเข้ารหัสสร้าง — ถ้าทั้งสองฝั่งเข้าใจสเปกตรงกันถึงจะได้ข้อความเดิมคืน
 *
 * จุดที่แข็งที่สุดคือการตรวจ Reed-Solomon ด้วย "syndrome" (แทนค่า α^i ลงในพหุนามของบล็อก)
 * ซึ่งเป็นคนละวิธีกับที่ตัวเข้ารหัสใช้ (หารยาวด้วยพหุนามตัวสร้าง) ผลลัพธ์ต้องเป็นศูนย์ทุกตัว
 * ถ้าคิด EC ผิด วิธีนี้จับได้ ต่างจากการเอาโค้ดเดิมมาคำนวณซ้ำแล้วเทียบกับตัวเอง
 *
 * ═══ ตรวจกับของจริงแล้วด้วย ═══
 * ตอนพัฒนา เอาไฟล์ PNG ที่ออกจากตรงนี้ไปให้ตัวถอดรหัสของ Apple (CoreImage CIDetector)
 * อ่าน ครบทั้งเวอร์ชัน 1-20 รวม 80 ภาพ ถอดได้ตรงทุกภาพ — ดูวิธีทำซ้ำใน README
 */

import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { MAX_VERSION, dataCodewords, encodeQr, fitVersion } from "../src/qr-encode.js";
import { modulesToPng } from "../src/qr-png.js";
import { promptPayPayload } from "../src/promptpay.js";

/* ───────── ตัวถอดรหัสฉบับเทสต์ — เขียนใหม่จากสเปก ───────── */

const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const EC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

/* GF(256) แบบตาราง exp/log — คนละวิธีกับ gfMul() แบบเลื่อนบิตในตัวเข้ารหัส */
const EXP = new Array(512);
const LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

const alignmentPositions = (version) => {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
};

/* ช่องไหนเป็น "ลาย" ไม่ใช่ข้อมูล — สร้างใหม่จากสเปก ไม่ได้ขอจากตัวเข้ารหัส */
function functionMap(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true;
  };

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  const pos = alignmentPositions(version);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner =
        (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(pos[i] + dx, pos[j] + dy);
    }
  }
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(Math.floor(i / 3), size - 11 + (i % 3));
      mark(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return fn;
}

/* อ่านบิต format 15 บิตกลับมา แล้วตรวจ BCH ว่าไม่มีบิตไหนเพี้ยน */
function readFormat(modules) {
  const size = modules.length;
  const positions = [];
  for (let i = 0; i <= 5; i++) positions.push([8, i]);
  positions.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) positions.push([14 - i, 8]);

  let bits = 0;
  positions.forEach(([x, y], i) => {
    if (modules[y][x]) bits |= 1 << i;
  });

  const raw = bits ^ 0x5412;
  /* ตรวจว่าเป็นคำรหัส BCH(15,5) ที่ถูกต้อง: หารด้วย 0x537 แล้วเหลือศูนย์ */
  let rem = raw;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return { ecl: (raw >>> 13) & 3, mask: (raw >>> 10) & 7, bchRemainder: rem & 0x3ff, bits };
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/* เดินซิกแซกอ่านบิตกลับ แล้วประกอบเป็น codeword */
function readCodewords(modules, version, mask) {
  const size = modules.length;
  const fn = functionMap(version);
  const bits = [];

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (fn[y][x]) continue;
        bits.push((modules[y][x] !== MASKS[mask](x, y)) ? 1 : 0);
      }
    }
  }

  const total = Math.floor(bits.length / 8);
  return Array.from({ length: total }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
}

/* คลายการสานกลับเป็นบล็อก (ข้อมูล + EC ของแต่ละบล็อก) */
function deinterleave(codewords, version) {
  const numBlocks = EC_BLOCKS[version];
  const eccLen = EC_PER_BLOCK[version];
  const raw = codewords.length;
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);

  /*
   * ทุกบล็อกถูกสานด้วย "ความยาวเท่ากัน" คือ shortLen+1 ช่อง
   * โดยบล็อกสั้นมีช่องว่าง 1 ช่องคาอยู่ตรงรอยต่อระหว่างข้อมูลกับ EC (ถูกข้ามตอนสาน)
   * อ่านกลับจึงต้องไล่ทุก i แล้วข้ามช่องนั้นช่องเดียว ห้ามตัดท้ายบล็อกสั้นทิ้ง
   */
  const blocks = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortLen - eccLen && j < shortBlocks) continue; // ช่องว่างของบล็อกสั้น
      blocks[j].push(codewords[k++]);
    }
  }

  const dataLens = Array.from({ length: numBlocks }, (_, j) => shortLen - eccLen + (j < shortBlocks ? 0 : 1));
  return { blocks, eccLen, dataLens };
}

/*
 * ตรวจ Reed-Solomon ด้วย syndrome — S_i = r(α^i) ต้องเป็น 0 ทุกตัวถ้า EC ถูก
 * เป็นคนละวิธีกับที่ตัวเข้ารหัสใช้คำนวณ จึงจับได้ถ้าฝั่งเข้ารหัสคิดผิด
 */
function syndromes(block, eccLen) {
  return Array.from({ length: eccLen }, (_, i) => {
    let acc = 0;
    for (const byte of block) acc = mul(acc, EXP[i]) ^ byte;
    return acc;
  });
}

/* แกะหัวข้อมูล byte mode กลับเป็นข้อความ */
function parseData(data, version) {
  const bits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  const take = (n) => bits.splice(0, n).reduce((a, b) => (a << 1) | b, 0);

  assert.equal(take(4), 0b0100, "ต้องเป็น byte mode");
  const length = take(version <= 9 ? 8 : 16);
  return Buffer.from(Array.from({ length }, () => take(8))).toString("utf8");
}

/* ถอดรหัสครบวงจร + ยืนยัน EC ระหว่างทาง */
function decode(qr) {
  const format = readFormat(qr.modules);
  assert.equal(format.bchRemainder, 0, "บิต format ต้องผ่าน BCH");
  assert.equal(format.ecl, 0, "ระดับแก้ความผิดพลาดต้องเป็น M");

  const { blocks, eccLen, dataLens } = deinterleave(readCodewords(qr.modules, qr.version, format.mask), qr.version);

  blocks.forEach((block, i) => {
    assert.deepEqual(syndromes(block, eccLen), new Array(eccLen).fill(0), `บล็อกที่ ${i + 1}: EC ไม่ถูกต้อง`);
  });

  const data = blocks.flatMap((b, i) => b.slice(0, dataLens[i]));
  return { text: parseData(data, qr.version), mask: format.mask };
}

/* ───────── เทสต์ ───────── */

test("ถอดรหัสกลับได้ข้อความเดิม และ EC ถูกต้อง — ทุกเวอร์ชัน 1-20", () => {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const max = dataCodewords(v) - (v <= 9 ? 2 : 3);
    for (const len of new Set([1, Math.floor(max / 2), max - 1, max])) {
      const text = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 7 + v) % 90))).join("");
      const decoded = decode(encodeQr(text, { version: v }));
      assert.equal(decoded.text, text, `เวอร์ชัน ${v} ความยาว ${len} ถอดกลับไม่ตรง`);
    }
  }
});

test("payload พร้อมเพย์จริงถอดกลับได้ตรงทุกตัวอักษร", () => {
  for (const amount of [1, 189, 1234.5, 99_999.99]) {
    const payload = promptPayPayload({ phone: "099-999-9999", amount });
    assert.equal(decode(encodeQr(payload)).text, payload, `ยอด ${amount} ถอดกลับไม่ตรง`);
  }
});

test("ลายที่เครื่องสแกนใช้หาตัว QR ต้องอยู่ครบ", () => {
  const { modules, size } = encodeQr("ทดสอบลาย");

  /* ลายระบุมุม 3 มุม: กรอบนอกดำ · วงในขาว · แกนกลางดำ 3×3 */
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        assert.equal(modules[cy + dy][cx + dx], dist !== 2, `ลายระบุมุม (${cx},${cy}) เพี้ยนที่ (${dx},${dy})`);
      }
    }
  }

  /* ลายจับเวลาต้องสลับดำขาวตลอดแนว — ถ้าถูกลายอื่นวาดทับจะพังตรงนี้ */
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `ลายจับเวลาแนวนอนเพี้ยนที่ ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `ลายจับเวลาแนวตั้งเพี้ยนที่ ${i}`);
  }

  assert.equal(modules[size - 8][8], true, "โมดูลดำถาวรที่สเปกบังคับ");
});

test("เลือกเวอร์ชันเล็กที่สุดที่พอดี ไม่เผื่อเกินจำเป็น", () => {
  assert.equal(fitVersion(1), 1);
  assert.equal(fitVersion(dataCodewords(1) - 2), 1, "ยาวพอดีความจุ v1 ต้องยังเป็น v1");
  assert.equal(fitVersion(dataCodewords(1) - 1), 2, "เกินไป 1 ไบต์ต้องขยับเป็น v2");
  assert.equal(fitVersion(dataCodewords(MAX_VERSION)), null, "ยาวเกิน v20 = ไม่มีเวอร์ชันรองรับ");
});

test("ข้อมูลยาวเกินความจุ → โยน error ไม่ใช่ตัดข้อมูลทิ้งเงียบ ๆ", () => {
  /* QR ที่สแกนได้แต่ payload ขาดครึ่ง = ลูกค้าโอนผิดยอดโดยไม่มีใครเห็นว่าพัง */
  assert.throws(() => encodeQr("x".repeat(dataCodewords(MAX_VERSION) + 10)), RangeError);
  assert.throws(() => encodeQr("x".repeat(100), { version: 1 }), RangeError);
});

test("ไฟล์ PNG ที่ออกมาเป็น PNG ที่ถูกต้อง และพิกเซลตรงกับตาราง", () => {
  const qr = encodeQr(promptPayPayload({ phone: "099-999-9999", amount: 189 }));
  const scale = 4;
  const quiet = 4;
  const png = modulesToPng(qr.modules, { scale, quietZone: quiet });

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "ลายเซ็น PNG");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");

  const side = (qr.size + quiet * 2) * scale;
  assert.equal(png.readUInt32BE(16), side, "ความกว้าง");
  assert.equal(png.readUInt32BE(20), side, "ความสูง");
  assert.equal(png[24], 8, "8 บิตต่อช่อง");
  assert.equal(png[25], 0, "grayscale");

  /* คลาย IDAT ออกมาแล้วไล่เทียบพิกเซลกับตารางโมดูลจริง */
  const start = 33;
  const idatLen = png.readUInt32BE(start);
  assert.equal(png.subarray(start + 4, start + 8).toString("ascii"), "IDAT");
  const raster = zlib.inflateSync(png.subarray(start + 8, start + 8 + idatLen));
  assert.equal(raster.length, (side + 1) * side, "ขนาด raster ต้องมีไบต์ filter นำหน้าทุกแถว");

  const pixel = (x, y) => raster[y * (side + 1) + 1 + x];
  for (let my = 0; my < qr.size; my += 3) {
    for (let mx = 0; mx < qr.size; mx += 3) {
      const px = (mx + quiet) * scale + 1;
      const py = (my + quiet) * scale + 1;
      assert.equal(pixel(px, py), qr.modules[my][mx] ? 0x00 : 0xff, `พิกเซลของโมดูล (${mx},${my}) ไม่ตรง`);
    }
  }

  /* ขอบขาวรอบภาพต้องขาวจริง — ขาดขอบนี้เครื่องสแกนหลายตัวหา QR ไม่เจอเลย */
  for (let i = 0; i < side; i++) {
    assert.equal(pixel(i, 0), 0xff, "ขอบบนต้องขาว");
    assert.equal(pixel(0, i), 0xff, "ขอบซ้ายต้องขาว");
    assert.equal(pixel(i, side - 1), 0xff, "ขอบล่างต้องขาว");
    assert.equal(pixel(side - 1, i), 0xff, "ขอบขวาต้องขาว");
  }
});

test("ภาพ QR เล็กพอส่งผ่าน LINE (เพดาน 1 MB)", () => {
  const png = modulesToPng(encodeQr("x".repeat(dataCodewords(MAX_VERSION) - 3)).modules, { scale: 8 });
  assert.ok(png.length < 1_000_000, `ภาพใหญ่เกินไป: ${png.length} ไบต์`);
});
