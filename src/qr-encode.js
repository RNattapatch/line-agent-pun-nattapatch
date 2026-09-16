/*
 * QR Code (ISO/IEC 18004, Model 2) — เข้ารหัสเป็นตารางโมดูลเอง ไม่ใช้ไลบรารีนอก
 *
 * ═══ ทำไมเขียนเอง ไม่เรียกบริการสร้าง QR ข้างนอก ═══
 * QR รับเงินมี 2 อย่างอยู่ข้างใน: เลขพร้อมเพย์ของร้าน กับยอดที่ลูกค้าจะโอน
 * ถ้าไปเรียก API ข้างนอกให้วาดให้ เท่ากับส่งทั้งสองอย่างออกไปนอกเครื่องทุกครั้งที่มีออเดอร์
 * และที่แย่กว่านั้นคือ "ภาพที่ลูกค้าสแกน" มาจากมือคนอื่น — วันไหนปลายทางนั้นถูกยึด
 * หรือเปลี่ยนเลขในภาพเงียบ ๆ เงินลูกค้าจะวิ่งไปบัญชีอื่นโดยไม่มีใครรู้จนกว่าจะสาย
 * ทุกอย่างจึงเกิดบน VPS ของเราเอง: payload → ตารางโมดูล → ไฟล์ PNG
 *
 * ═══ ขอบเขตที่จงใจ ═══
 * รองรับเฉพาะ byte mode + ระดับแก้ความผิดพลาด M (15%) เวอร์ชัน 1-20
 * พอสำหรับ payload พร้อมเพย์ (~100-180 ตัวอักษร) แบบเหลือ ๆ และตัดตารางที่ต้องพกไป
 * ได้ครึ่งหนึ่ง — ตารางที่ไม่เคยถูกใช้คือตารางที่ไม่มีใครรู้ว่าพิมพ์ผิด
 *
 * อ้างอิงโครงสร้าง/สูตร: ISO/IEC 18004 · โครงตามตำราอ้างอิงของ Project Nayuki
 */

/* ระดับ M — จำนวน EC codeword ต่อบล็อก และจำนวนบล็อก แยกตามเวอร์ชัน (ดัชนี = เวอร์ชัน) */
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const EC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

export const MIN_VERSION = 1;
export const MAX_VERSION = 20;

/* ระดับ M ในช่องข้อมูล format = 0b00 */
const ECL_FORMAT_BITS = 0;

const sizeOf = (version) => version * 4 + 17;

/*
 * จำนวน "โมดูลข้อมูลดิบ" ของเวอร์ชันหนึ่ง = โมดูลทั้งหมด ลบส่วนที่เป็นลาย
 * ผลลัพธ์อาจไม่ลงตัว 8 พอดี (เวอร์ชัน 14+ เหลือเศษ 3-7 บิต ตามสเปก) จึงต้องปัดลงเสมอ
 */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const totalCodewords = (version) => Math.floor(rawDataModules(version) / 8);

/* จำนวนไบต์ข้อมูลจริงที่ใส่ได้ในเวอร์ชันนั้น (หักส่วนแก้ความผิดพลาดออกแล้ว) */
export const dataCodewords = (version) =>
  totalCodewords(version) - EC_PER_BLOCK[version] * EC_BLOCKS[version];

/*
 * เวอร์ชันเล็กที่สุดที่ใส่ข้อมูลชุดนี้ได้ — คืน null ถ้ายาวเกินเวอร์ชัน 20
 * หัวข้อมูลกินไป 4 บิต (โหมด) + ตัวนับความยาว (8 บิตถ้าเวอร์ชัน 1-9, 16 บิตถ้า 10 ขึ้นไป)
 */
export function fitVersion(byteLength) {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewords(v) * 8) return v;
  }
  return null;
}

/* ───────── ชั้นที่ 1: ข้อมูล → codeword ───────── */

function toDataCodewords(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8); // ปัดให้ครบไบต์

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  /* ไบต์เติมของสเปกคือ EC,11 สลับกันไปจนเต็ม — ค่าคงที่ ไม่ใช่ศูนย์ */
  for (let pad = 0xec; out.length < dataCodewords(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/* ───────── ชั้นที่ 2: Reed-Solomon บน GF(256) ───────── */

/* คูณในสนาม GF(2^8) ด้วย primitive polynomial 0x11D ตามที่ QR กำหนด */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/* พหุนามตัวสร้าง degree ตัวแรกที่ผลหารบอกตำแหน่งที่ผิด — (x-α⁰)(x-α¹)…(x-α^(n-1)) */
function generatorPoly(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/* เศษจากการหารข้อมูลด้วยพหุนามตัวสร้าง = codeword แก้ความผิดพลาดของบล็อกนั้น */
function remainder(data, generator) {
  const result = new Array(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < generator.length; i++) result[i] ^= gfMul(generator[i], factor);
  }
  return result;
}

/*
 * แบ่งข้อมูลเป็นบล็อก คิด EC ของแต่ละบล็อก แล้ว "สาน" กลับเป็นลำดับเดียว
 *
 * ที่ต้องสานสลับบล็อกกันไม่ใช่เรื่องสวยงาม แต่เพราะรอยเปื้อนบนกระดาษ/นิ้วบังหน้าจอ
 * มักทำให้โมดูลที่อยู่ติดกันพังพร้อมกันเป็นหย่อม ถ้าเรียงทีละบล็อกจนจบ หย่อมเดียว
 * จะกินบล็อกเดียวจนเกินที่ EC รับไหว — สานแล้วความเสียหายจะกระจายไปทุกบล็อกเท่า ๆ กัน
 */
function interleave(data, version) {
  const numBlocks = EC_BLOCKS[version];
  const eccLen = EC_PER_BLOCK[version];
  const raw = totalCodewords(version);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const generator = generatorPoly(eccLen);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + len);
    k += len;
    const ecc = remainder(chunk, generator);
    /* บล็อกสั้นเติมช่องว่างไว้ 1 ช่องเพื่อให้ index ตรงกับบล็อกยาวตอนสาน แล้วข้ามตอนอ่านออก */
    blocks.push([...chunk, ...(i < shortBlocks ? [0] : []), ...ecc]);
  }

  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(blocks[j][i]);
    }
  }
  return out;
}

/* ───────── ชั้นที่ 3: วางลงตาราง ───────── */

const ALIGNMENT_CENTER = 6;

function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [ALIGNMENT_CENTER];
  for (let pos = sizeOf(version) - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function newMatrix(size, value = false) {
  return Array.from({ length: size }, () => new Array(size).fill(value));
}

/*
 * ตำแหน่งของบิต format ทั้ง 15 บิต — ชุดที่ 1 รอบลายระบุมุมซ้ายบน ชุดที่ 2 กระจายอีกสองมุม
 * (สเปกวางไว้ 2 ชุดเพื่อให้ยังอ่านได้แม้มุมหนึ่งเสียหาย)
 *
 * คืนเป็นตารางเดียวให้ทั้ง "ตอนจองช่อง" และ "ตอนเขียนค่าจริง" ใช้ร่วมกัน
 * เคยเขียนแยกกันสองที่แล้วสลับแถวกับคอลัมน์กันเองโดยไม่มีอะไรจับได้ — QR ออกมาสวย สแกนไม่ติด
 */
function formatPositions(size) {
  const first = [];
  for (let i = 0; i <= 5; i++) first.push([8, i]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) first.push([14 - i, 8]);

  const second = [];
  for (let i = 0; i < 8; i++) second.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) second.push([8, size - 15 + i]);

  return { first, second };
}

/* ลายที่ต้องมีเสมอ: ลายจับเวลา · ลายระบุมุม · ลายปรับตำแหน่ง · ช่องจองของ format/version */
function drawFunctionPatterns(modules, reserved, version) {
  const size = sizeOf(version);

  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  /*
   * ลายจับเวลาต้องวาด "ก่อน" ลายระบุมุมเสมอ — แถวกับคอลัมน์ที่ 6 พาดทับมุมทั้งสาม
   * ถ้าวาดทีหลังจะไปเซาะลายระบุมุมเป็นลายทาง แล้วเครื่องสแกนหาตัว QR ไม่เจอเลย
   */
  for (let i = 0; i < size; i++) {
    set(ALIGNMENT_CENTER, i, i % 2 === 0);
    set(i, ALIGNMENT_CENTER, i % 2 === 0);
  }

  /* ลายระบุมุม 3 มุม + เส้นคั่นรอบนอก (กรอบ 9×9 รอบจุดกึ่งกลาง — ทับลายจับเวลาตรงที่ซ้อนกัน) */
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  /* ลายปรับตำแหน่ง — ข้ามสามมุมที่ทับกับลายระบุมุมไปแล้ว */
  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  /* จองช่อง format ไว้ก่อน ค่าจริงเติมตอนรู้แล้วว่าเลือก mask ไหน */
  const { first, second } = formatPositions(size);
  for (const [x, y] of [...first, ...second]) set(x, y, false);
  set(8, size - 8, true); // โมดูลดำถาวรที่สเปกบังคับ

  /* ช่องบอกเวอร์ชัน — มีเฉพาะเวอร์ชัน 7 ขึ้นไป (BCH(18,6)) */
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      set(Math.floor(i / 3), size - 11 + (i % 3), dark);
      set(size - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }
}

/* format = ระดับ EC + หมายเลข mask ป้องกันด้วย BCH(15,5) แล้ว XOR 0x5412 ตามสเปก */
function drawFormat(modules, version, mask) {
  const size = sizeOf(version);
  const data = (ECL_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const { first, second } = formatPositions(size);
  for (const copy of [first, second]) {
    copy.forEach(([x, y], i) => {
      modules[y][x] = ((bits >>> i) & 1) !== 0;
    });
  }
  modules[size - 8][8] = true;
}

/* เดินซิกแซกจากมุมขวาล่างขึ้นไป ทีละ 2 คอลัมน์ ข้ามช่องที่เป็นลาย */
function drawCodewords(modules, reserved, version, codewords) {
  const size = sizeOf(version);
  let i = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === ALIGNMENT_CENTER) right = 5; // คอลัมน์ลายจับเวลาไม่นับเป็นคอลัมน์ข้อมูล
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - v : v;
        if (reserved[y][x]) continue;
        /* บิตที่เกินข้อมูล (เศษ 3-7 บิตของเวอร์ชัน 14+) ปล่อยเป็นขาวตามสเปก */
        modules[y][x] = i < codewords.length * 8 && ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        i++;
      }
    }
  }
}

/* สูตร mask ทั้ง 8 แบบของสเปก — สลับสีโมดูลข้อมูลเพื่อไม่ให้เกิดลายที่สแกนแล้วสับสน */
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

const applyMask = (modules, reserved, mask) => {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  }
};

/*
 * คะแนนโทษ — ยิ่งน้อยยิ่งสแกนง่าย เลือก mask ที่ได้คะแนนต่ำสุด
 * 4 ข้อของสเปก: แถวยาวสีเดียว · บล็อก 2×2 สีเดียว · ลายที่คล้ายลายระบุมุม · ดำ/ขาวไม่สมดุล
 */
function penalty(modules) {
  const size = modules.length;
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let runLength = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) {
        runLength++;
        continue;
      }
      if (runLength >= 5) total += 3 + (runLength - 5);
      runLength = 1;
    }
    /* ลายเลียนลายระบุมุม 1:1:3:1:1 ที่มีช่องว่าง 4 โมดูลข้างใดข้างหนึ่ง */
    const s = line.map((d) => (d ? "1" : "0")).join("");
    for (const pat of ["10111010000", "00001011101"]) {
      let from = 0;
      for (;;) {
        const at = s.indexOf(pat, from);
        if (at < 0) break;
        total += 40;
        from = at + 1;
      }
    }
    return total;
  };

  for (let i = 0; i < size; i++) {
    score += runScore(modules[i]);
    score += runScore(modules.map((row) => row[i]));
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }

  const dark = modules.flat().filter(Boolean).length;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

  return score;
}

/*
 * เข้ารหัสสตริง → { version, size, modules } โดย modules[y][x] เป็น true เมื่อเป็นโมดูลสีดำ
 * โยน error ถ้าข้อมูลยาวเกินเวอร์ชัน 20 — ห้ามคืน QR ที่ตัดข้อมูลทิ้งเด็ดขาด
 * (QR ที่สแกนได้แต่ payload ขาดครึ่ง = ลูกค้าโอนผิดยอดโดยไม่มีใครเห็นว่าพัง)
 */
export function encodeQr(text, { version: forced } = {}) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  const version = forced ?? fitVersion(bytes.length);
  if (!version || version < MIN_VERSION || version > MAX_VERSION) {
    throw new RangeError(`ข้อมูลยาว ${bytes.length} ไบต์ เกินที่ QR เวอร์ชัน ${MAX_VERSION} รับได้`);
  }
  if (bytes.length > dataCodewords(version) - (version <= 9 ? 2 : 3)) {
    throw new RangeError(`ข้อมูลยาวเกินความจุของ QR เวอร์ชัน ${version}`);
  }

  const size = sizeOf(version);
  const modules = newMatrix(size);
  const reserved = newMatrix(size);

  drawFunctionPatterns(modules, reserved, version);
  drawCodewords(modules, reserved, version, interleave(toDataCodewords(bytes, version), version));

  /* ลอง mask ทั้ง 8 แบบแล้วเก็บแบบที่คะแนนโทษต่ำสุด — ต้องถอน mask เดิมออกก่อนลองตัวถัดไป */
  let best = { mask: 0, score: Infinity };
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, reserved, mask);
    drawFormat(modules, version, mask);
    const score = penalty(modules);
    if (score < best.score) best = { mask, score };
    applyMask(modules, reserved, mask);
  }
  applyMask(modules, reserved, best.mask);
  drawFormat(modules, version, best.mask);

  return { version, size, mask: best.mask, modules };
}
