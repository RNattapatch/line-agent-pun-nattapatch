/*
 * อ่านค่าจาก .env เข้ามาใน process.env
 *
 * เขียนเองสั้น ๆ แทนการลง dotenv เพราะ repo นี้ตั้งใจให้ dependency น้อยที่สุด
 * (ยิ่ง dependency น้อย ยิ่งมีที่ให้ supply-chain attack แทรกน้อย — เซิร์ฟเวอร์ตัวนี้เปิดรับทราฟฟิกจากเน็ต)
 *
 * ค่าที่ตั้งมาจาก environment จริงอยู่แล้ว (เช่นบน host ที่ deploy) ชนะค่าจากไฟล์เสมอ
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
