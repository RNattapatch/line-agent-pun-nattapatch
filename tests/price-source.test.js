/*
 * เทสต์แหล่งราคา — products.md ต้องเป็นแหล่งเดียวจริง ๆ ไม่ใช่แค่พูดไว้ในคอมเมนต์
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatBaht, formatPrice, loadPriceList, priceOf } from "../src/price-source.js";
import { PRODUCTS } from "../src/products.js";

const tempMd = (body) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "price-")), "products.md");
  fs.writeFileSync(file, body);
  return file;
};

const table = (rows) =>
  ["## ตารางราคา", "", "| # | ชื่อสินค้า | ราคา (บาท) | หน่วย |", "|---|---|---|---|", ...rows, "", "## อื่น ๆ"].join("\n");

test("อ่านราคาจากตารางใน products.md จริง ได้ครบทุกตัว", () => {
  const list = loadPriceList();

  assert.equal(list.ok, true);
  assert.equal(list.missing.length, 0, "ตอนนี้ products.md ต้องมีราคาครบ");
  assert.equal(list.items.length, PRODUCTS.length, "จำนวนสินค้าต้องตรงกับแคตตาล็อก");

  for (const item of list.items) {
    assert.ok(item.slug, `${item.name} ต้องจับคู่กับ slug ได้`);
    assert.equal(item.satang, Math.round(item.price * 100));
  }
});

test("ราคาใน src/products.js ตรงกับตารางใน products.md (กันแหล่งราคาที่สอง)", () => {
  for (const entry of loadPriceList().items) {
    const catalog = PRODUCTS.find((p) => p.slug === entry.slug);
    assert.equal(formatPrice(entry), catalog.price, `${entry.name} ราคาไม่ตรงกัน`);
  }
});

test('ราคาที่เขียนว่า "ยังไม่ระบุ" → เข้าช่อง missing ห้ามเดา', () => {
  const file = tempMd(table(["| 1 | ขนมปังชิโอะปัง | 15 | ชิ้น |", "| 2 | เค้กกล้วยหอม | ยังไม่ระบุ | ชิ้น |"]));
  const list = loadPriceList({ file });

  assert.equal(list.items.length, 1);
  assert.deepEqual(list.missing.map((m) => m.name), ["เค้กกล้วยหอม"]);
  assert.equal(priceOf("banana-cake", list), null);
});

test("ราคาที่ไม่ใช่ตัวเลข (ตามจริง / ว่าง) ก็ถือว่าไม่ครบ", () => {
  const file = tempMd(table(["| 1 | ค่าส่ง | ตามจริง | ครั้ง |", "| 2 | ของแถม |  | ชิ้น |"]));
  const list = loadPriceList({ file });

  assert.equal(list.items.length, 0);
  assert.equal(list.missing.length, 2);
});

test("ไฟล์หาย / หัวตารางเปลี่ยน → ตอบว่าอ่านไม่ได้ ไม่ใช่เดาเงียบ ๆ", () => {
  assert.equal(loadPriceList({ file: "/ไม่มีไฟล์นี้.md" }).ok, false);

  const broken = tempMd("| ชื่อ | เงิน |\n|---|---|\n| ขนมปัง | 15 |");
  assert.equal(loadPriceList({ file: broken }).ok, false, "หัวตารางไม่ตรง = ไม่รับ ดีกว่าอ่านผิดช่อง");
});

test("checksum เปลี่ยนเมื่อราคาเปลี่ยน — ใช้ย้อนดูว่าใบไหนออกตอนราคาเท่าไหร่", () => {
  const before = loadPriceList({ file: tempMd(table(["| 1 | ขนมปังชิโอะปัง | 15 | ชิ้น |"])) });
  const after = loadPriceList({ file: tempMd(table(["| 1 | ขนมปังชิโอะปัง | 18 | ชิ้น |"])) });

  assert.notEqual(before.checksum, after.checksum);
});

test("จำนวนเงินโชว์ 2 ตำแหน่งเสมอ", () => {
  assert.equal(formatBaht(378), "378.00");
  assert.equal(formatBaht(538.65), "538.65");
  assert.equal(formatBaht(75600), "75,600.00");
});
