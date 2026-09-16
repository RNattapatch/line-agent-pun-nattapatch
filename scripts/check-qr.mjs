/*
 * ตรวจตัวสร้าง QR — สร้างภาพจริงออกมาให้สแกนด้วยมือถือ แล้วแกะ payload ให้อ่านทีละช่อง
 *
 *   npm run check:qr                       สร้างชุดตัวอย่าง + แกะ payload
 *   npm run check:qr -- --amount 1250.50   กำหนดยอดเอง
 *   npm run check:qr -- --id 081-234-5678  กำหนดเลขพร้อมเพย์เอง (ไม่งั้นใช้เลขตัวอย่าง)
 *
 * ถ้าเครื่องนี้เป็น Mac ที่มี swiftc จะถอดรหัสภาพซ้ำด้วย CoreImage ของ Apple ให้ด้วย
 * เป็นการตรวจกับ "ตัวถอดรหัสที่ไม่เกี่ยวกับเราเลย" ซึ่งใกล้เคียงกับการสแกนด้วยแอปธนาคารที่สุด
 * (บน VPS ที่เป็น Linux จะข้ามขั้นนี้ไป — เทสต์ใน tests/qr.test.js ครอบอยู่แล้ว)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { promptPayPayload, crc16 } from "../src/promptpay.js";
import { encodeQr } from "../src/qr-encode.js";
import { modulesToPng } from "../src/qr-png.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/* เลขตัวอย่าง ไม่ใช่ของร้านจริง — เลขจริงอยู่ใน ENV เท่านั้น ห้ามเขียนลงไฟล์ในนี้ */
const phone = arg("id", "081-234-5678");
const amount = Number(arg("amount", "189"));

const FIELDS = {
  "00": "รูปแบบ payload",
  "01": "ชนิด QR",
  "29": "ข้อมูลผู้รับ (พร้อมเพย์)",
  "53": "สกุลเงิน",
  "54": "ยอดเงิน",
  "58": "ประเทศ",
  "63": "CRC",
};
const SUBFIELDS = { "00": "รหัสพร้อมเพย์ (AID)", "01": "เลขปลายทาง" };

function explain(payload, names = FIELDS, indent = "") {
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    const value = payload.slice(i + 4, i + 4 + len);
    console.log(`${indent}  ${id}  ${(names[id] ?? "?").padEnd(24)} = ${value}`);
    if (id === "29") explain(value, SUBFIELDS, `${indent}      `);
    i += 4 + len;
  }
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-qr-"));
const payload = promptPayPayload({ phone, amount });

if (!payload) {
  console.error(`❌ ประกอบ payload ไม่ได้ — เลข "${phone}" หรือยอด "${amount}" ใช้ไม่ได้`);
  process.exit(1);
}

const qr = encodeQr(payload);
const file = path.join(outDir, "promptpay.png");
fs.writeFileSync(file, modulesToPng(qr.modules, { scale: 10 }));

console.log(`\n🔍 payload ที่จะฝังลง QR (${payload.length} ตัวอักษร)\n`);
explain(payload);

const crcOk = payload.slice(-4) === crc16(payload.slice(0, -4));
console.log(`\n  CRC ${crcOk ? "✅ ถูกต้อง" : "❌ ผิด"}`);
console.log(`  QR เวอร์ชัน ${qr.version} · ${qr.size}×${qr.size} โมดูล · mask ${qr.mask}`);
console.log(`\n🖼  ไฟล์ภาพ: ${file} (${fs.statSync(file).size.toLocaleString()} ไบต์)`);

/* ───────── ถอดรหัสซ้ำด้วยตัวถอดของ Apple ถ้ามี ───────── */

let hasSwift = false;
try {
  execFileSync("which", ["swiftc"], { stdio: "ignore" });
  hasSwift = true;
} catch {
  /* ไม่มี swiftc — ข้ามไป */
}

if (!hasSwift) {
  console.log("\nℹ️  ไม่มี swiftc บนเครื่องนี้ — ข้ามการถอดรหัสซ้ำด้วย CoreImage");
  console.log("   เอาไฟล์ข้างบนไปสแกนด้วยแอปธนาคารเพื่อตรวจด้วยตาได้เลย (อย่ากดจ่าย)");
  process.exit(0);
}

const swift = path.join(outDir, "decode.swift");
fs.writeFileSync(
  swift,
  `import Foundation
import CoreImage
let ctx = CIContext()
let d = CIDetector(ofType: CIDetectorTypeQRCode, context: ctx,
                   options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
for p in CommandLine.arguments.dropFirst() {
    guard let img = CIImage(contentsOf: URL(fileURLWithPath: p)) else { print("LOADFAIL"); continue }
    let f = d.features(in: img).compactMap { $0 as? CIQRCodeFeature }
    print(f.first?.messageString ?? "NODECODE")
}
`,
);

const bin = path.join(outDir, "decode");
execFileSync("swiftc", ["-O", swift, "-o", bin], { stdio: "inherit" });
const decoded = execFileSync(bin, [file], { encoding: "utf8" }).trim();

console.log("\n🧪 ถอดรหัสภาพซ้ำด้วย CoreImage ของ Apple (ตัวถอดที่ไม่เกี่ยวกับโค้ดเรา)");
if (decoded === payload) {
  console.log("   ✅ ถอดกลับได้ตรงกับ payload ทุกตัวอักษร");
} else {
  console.error(`   ❌ ไม่ตรง!\n      ได้: ${decoded}\n      ควรเป็น: ${payload}`);
  process.exit(1);
}

console.log("\n   เอาไฟล์ภาพไปสแกนด้วยแอปธนาคารอีกรอบเพื่อดูชื่อผู้รับกับยอด แล้วอย่ากดจ่ายนะคะ");
