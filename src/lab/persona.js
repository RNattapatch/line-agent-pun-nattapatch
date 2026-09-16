/*
 * อ่าน Persona ปัจจุบันจาก persona-current.md
 *
 * ═══ อ่านอย่างเดียว ไม่มีฟังก์ชันเขียนอยู่ในไฟล์นี้เลย ═══
 * จงใจไม่มี write/update/apply ให้เรียกได้ ต่อให้วันหนึ่งมีคนอยากให้ Lab
 * "อัปเดต persona ให้อัตโนมัติเลยสิ" ก็จะต้องเขียนโค้ดใหม่ทั้งก้อน ไม่ใช่แค่เรียกฟังก์ชันที่มีอยู่
 *
 * Persona เป็นคำตัดสินใจทางธุรกิจ ไม่ใช่ข้อสรุปทางสถิติ — ตัวเลขบอกได้ว่า
 * "มีคนกลุ่มนี้ทักเข้ามาเยอะขึ้น" แต่บอกไม่ได้ว่า "ร้านอยากขายให้กลุ่มนี้ไหม"
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const personaFile = () => path.join(ROOT, "persona-current.md");

/*
 * คืน { codes, names, goals, checksum }
 * checksum ใช้พิสูจน์ในเทสต์ว่าไฟล์ "ไม่ถูกแตะ" หลังกด Reject / Observe
 */
export function readPersona({ file = personaFile() } = {}) {
  let body = "";
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return { codes: [], names: {}, goals: [], checksum: null, missing: true };
  }

  const codes = [];
  const names = {};
  /* แต่ละกลุ่มเขียนเป็น "### ① ชื่อกลุ่ม" แล้วตามด้วย "- **รหัส:** `code`" */
  const re = /^###\s+\S*\s*(.+?)\s*$\n(?:[\s\S]*?)^-\s*\*\*รหัส:\*\*\s*`([a-z0-9_]+)`/gm;
  for (const m of body.matchAll(re)) {
    names[m[2]] = m[1];
    codes.push(m[2]);
  }

  const goals = [...body.matchAll(/^\d+\.\s+(.+?)\s*$/gm)].map((m) => m[1]);

  return {
    codes,
    names,
    goals,
    checksum: crypto.createHash("sha256").update(body).digest("hex"),
    missing: false,
  };
}
