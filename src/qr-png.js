/*
 * เขียนไฟล์ PNG เอง — ใช้แค่ zlib ที่ติดมากับ Node
 *
 * ทำไมไม่ลงไลบรารีวาดภาพ: เหตุผลเดียวกับทั้ง repo (ดู src/env.js) ยิ่ง dependency น้อย
 * ยิ่งมีที่ให้ supply-chain attack แทรกน้อย และไฟล์ที่ออกจากตรงนี้คือ "ภาพที่ลูกค้าสแกนเพื่อโอนเงิน"
 * ซึ่งเป็นจุดที่ไม่อยากให้โค้ดของคนอื่นแตะเลย
 *
 * PNG ที่ต้องการเป็นภาพขาวดำล้วน จึงใช้ grayscale 8 บิต (color type 0) ที่โครงสร้างง่ายที่สุด
 * ภาพ QR มีแต่พื้นที่สีเดียวติดกันเป็นแถบ deflate เลยบีบได้เหลือไม่กี่กิโลไบต์
 * (ใต้เพดาน 1 MB ของ LINE แบบสบาย ๆ — ดู MAX_PREVIEW_BYTES ใน src/image-cache.js)
 */

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/*
 * CRC-32 ของ PNG — เขียนเองแทน zlib.crc32 เพราะ zlib.crc32 เพิ่งมีใน Node รุ่นหลัง
 * package.json ประกาศรองรับ Node 20 ขึ้นไป ถ้าใช้ตัวนั้นจะพังบน Node 20.x ต้น ๆ เงียบ ๆ
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/*
 * ตาราง true/false → Buffer ของไฟล์ PNG
 *   scale     ความกว้างของ 1 โมดูลเป็นพิกเซล
 *   quietZone ขอบขาวรอบภาพ นับเป็นโมดูล — สเปก QR บังคับอย่างน้อย 4
 *             ขาดขอบนี้เครื่องสแกนหลายตัวจะหา QR ไม่เจอเลย ทั้งที่ลายข้างในถูกต้องทุกจุด
 */
export function modulesToPng(modules, { scale = 8, quietZone = 4 } = {}) {
  const count = modules.length + quietZone * 2;
  const side = count * scale;

  /* หนึ่งแถวของ PNG = ไบต์บอกวิธี filter (0 = ไม่ filter) + พิกเซลทั้งแถว */
  const stride = side + 1;
  const raster = Buffer.alloc(stride * side, 0xff);
  for (let y = 0; y < side; y++) raster[y * stride] = 0;

  for (let my = 0; my < modules.length; my++) {
    for (let mx = 0; mx < modules.length; mx++) {
      if (!modules[my][mx]) continue;
      const x0 = (mx + quietZone) * scale;
      const y0 = (my + quietZone) * scale;
      for (let dy = 0; dy < scale; dy++) {
        raster.fill(0x00, (y0 + dy) * stride + 1 + x0, (y0 + dy) * stride + 1 + x0 + scale);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // ไม่ interlace — เครื่องสแกนอ่านไฟล์ทั้งไฟล์อยู่แล้ว ไม่ต้องโหลดหยาบก่อน

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raster, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
