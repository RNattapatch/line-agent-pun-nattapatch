/*
 * ยามกันข้อมูลเพี้ยน — products.md คือแหล่งความจริงเรื่องราคาและรายการสินค้า
 * ไฟล์ src/products.js ก๊อปตัวเลขมาไว้ใช้ตอนตอบลูกค้า ถ้าเจ้าของร้านแก้ราคาในไฟล์ .md
 * แล้วไม่มีใครแก้ที่ .js ตาม บอทจะพูดราคาผิดโดยไม่มีใครรู้ เทสต์นี้เลยเทียบให้ทุกครั้งที่รัน npm test
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PRODUCTS, matchProduct } from "../src/products.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productsMd = fs.readFileSync(path.join(ROOT, "products.md"), "utf8");

/* ดึงตารางราคาหลักออกมา: | # | ชื่อสินค้า | ราคา | หน่วย | */
function priceTable() {
  const rows = productsMd
    .split("\n")
    .map((line) => line.split("|").map((c) => c.trim()))
    .filter((cells) => cells.length === 6 && /^\d+$/.test(cells[1]));

  return rows.map(([, , name, price, unit]) => ({ name, price: Number(price), unit }));
}

test("ตารางราคาใน products.md ยังอ่านออกอยู่", () => {
  // ถ้าเทสต์นี้แดง แปลว่ารูปแบบตารางเปลี่ยนไป — ต้องมาแก้ตัวอ่านข้างบน ไม่ใช่ลบเทสต์ทิ้ง
  assert.equal(priceTable().length, 4, "ควรอ่านเจอสินค้า 4 รายการ");
});

test("จำนวนสินค้าใน products.js ตรงกับ products.md", () => {
  assert.equal(PRODUCTS.length, priceTable().length);
});

test("ราคาทุกตัวใน products.js ตรงกับ products.md", () => {
  for (const row of priceTable()) {
    // ชื่อในตารางเป็นชื่อสั้น ("บราวนี่ (ชิ้น)") ตรงกับ name ใน products.js
    const product = PRODUCTS.find((p) => p.name === row.name);
    assert.ok(product, `products.js ไม่มีสินค้า "${row.name}" ที่อยู่ใน products.md`);

    const priceInCode = Number(product.price.replace(/[^\d]/g, ""));
    assert.equal(priceInCode, row.price, `ราคา "${row.name}" ไม่ตรงกับ products.md`);
    assert.match(product.price, new RegExp(row.unit), `หน่วยของ "${row.name}" ไม่ตรงกับ products.md`);
  }
});

test("ไม่มีสินค้าใน products.js ที่ไม่มีใน products.md", () => {
  const names = priceTable().map((r) => r.name);
  for (const p of PRODUCTS) {
    assert.ok(names.includes(p.name), `"${p.name}" ไม่มีใน products.md — ห้ามสร้างรูปให้ของที่ร้านไม่ได้ขาย`);
  }
});

test("ทุกสินค้ามีโจทย์รูปที่คุมสไตล์ให้เป็นชุดเดียวกัน", () => {
  for (const p of PRODUCTS) {
    assert.ok(p.prompt.length > 100, `${p.slug}: โจทย์สั้นเกินไป`);
    assert.match(p.prompt, /No text/, `${p.slug}: ต้องกันตัวหนังสือ/โลโก้ในรูป`);
    assert.match(p.prompt, /oak table/, `${p.slug}: ต้องใช้พื้นโต๊ะเดียวกันทั้งชุด`);
    assert.match(p.prompt, /no hands, no people/, `${p.slug}: ห้ามมีมือคนหรือคนในรูป`);
  }
});

test("จับคู่ข้อความลูกค้ากับสินค้าได้ถูกตัว", () => {
  assert.equal(matchProduct("ขอรูปชิโอะปัง").match.slug, "shio-pan");
  assert.equal(matchProduct("box set 1 มีอะไรบ้าง").match.slug, "box-set-1");
  assert.equal(matchProduct("บราวนี่กล่อง").match.slug, "brownie-box");
  assert.equal(matchProduct("บราวนี่ชิ้น").match.slug, "brownie-piece");

  // คำกว้าง ๆ ต้องเข้าเคสกำกวม ไม่ใช่เดาเอาเอง
  assert.equal(matchProduct("บราวนี่").ambiguous?.length, 2);

  // ของที่ร้านไม่ได้ขาย ต้องไม่ไปแมตช์อะไรทั้งนั้น
  assert.ok(matchProduct("ครัวซองต์").none);
  assert.ok(matchProduct("เค้กกล้วยหอม").none, "เค้กกล้วยหอมขายแยกไม่ได้ (products.md) ห้ามแมตช์เข้า Box Set");
});
