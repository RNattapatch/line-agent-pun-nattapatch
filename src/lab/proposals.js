/*
 * ตัวสร้างข้อเสนอ — Persona · FAQ · Script · Marketing Brief
 *
 * ═══ ทุกข้อเสนอต้องมีครบ 3 อย่างเสมอ ═══
 *   source_ids        มาจากเคสไหนบ้าง (pseudonymous) — ไม่มี = เถียงไม่ได้ ตรวจไม่ได้
 *   expected_impact   คาดว่าจะเกิดอะไร — ไม่มี = ไม่มีทางรู้ว่าทำแล้วได้ผลไหม
 *   rollback          ถ้าทำแล้วแย่ลง ถอยกลับยังไง — ไม่มี = ไม่มีใครกล้ากด Approve
 *
 * ข้อเสนอที่ขาดข้อใดข้อหนึ่งจะถูกตัดทิ้งตั้งแต่ตรงนี้ ไม่ปล่อยให้ไปโผล่ในรายงาน
 *
 * ═══ Lab ไม่แก้ไฟล์เอง ═══
 * ทุกอย่างในไฟล์นี้ "ประกอบข้อความ" อย่างเดียว ไม่มีการเขียนทับไฟล์ไหนทั้งสิ้น
 * แม้แต่ตอนเจ้าของร้านกด Approve — Approve แปลว่า "รับเรื่องไว้ให้คนไปทำ"
 * ไม่ใช่ "ทำเลย" (ดู src/lab/ledger.js)
 */

import crypto from "node:crypto";

import { EMERGING_MIN } from "./insights.js";

/* เป้าหมายธุรกิจ → ใช้จัดลำดับว่าข้อเสนอไหนควรอยู่บนสุด */
const GOAL_WEIGHT = {
  office: 3, // ตรงกับเป้าหมาย "เจาะกลุ่มพนักงานออฟฟิศ"
  bulk_buyer: 2,
  morning_shopper: 1,
};

const SIGNAL_LABEL = {
  office: "พนักงานออฟฟิศ (สั่งเป็นเซ็ตช่วงพักเที่ยง/ค่ำ)",
  bulk_buyer: "ลูกค้าซื้อยกล็อต",
  morning_shopper: "ลูกค้าช่วงเช้า",
  event_organizer: "คนจัดงาน/อีเวนต์",
};

const label = (signal) => SIGNAL_LABEL[signal] ?? signal;

const idOf = (parts) => `prop-${crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 10)}`;

/*
 * rollback pointer — ชี้ว่าถ้าทำแล้วอยากถอย ต้องถอยที่ไหน
 *
 * เก็บ checksum ของไฟล์เป้าหมาย ณ ตอนที่เสนอไว้ด้วย
 * ถ้าวันที่จะถอยกลับแล้ว checksum ไม่ตรง แปลว่ามีคนแก้ไฟล์นั้นระหว่างทาง
 * ต้องอ่านก่อนถอย ไม่ใช่ถอยทับของใหม่ทิ้ง
 */
const rollbackFor = (target, checksum, gitRef) => ({
  target,
  checksum_at_proposal: checksum,
  git_ref_at_proposal: gitRef,
  method:
    `ถอยกลับด้วย: git checkout ${gitRef ?? "<commit ก่อนแก้>"} -- ${target}` +
    " · ถ้า checksum ไม่ตรงกับตอนเสนอ แปลว่ามีคนแก้ไฟล์นี้ระหว่างทาง ให้อ่านก่อนถอย",
});

/*
 * สร้างข้อเสนอจากผลวิเคราะห์ — คืนอาร์เรย์เรียงตามลำดับความสำคัญ
 * ทุกใบ status = "pending" เสมอ ไม่มีทางออกมาเป็นอย่างอื่น
 */
export function buildProposals({ weekly, daily, persona, gitRef = null, now = () => new Date() } = {}) {
  const out = [];
  const at = now().toISOString();
  const personaChecksum = persona?.checksum ?? null;

  const push = (p) => {
    /* ด่านสุดท้าย: ขาดอะไรอย่างหนึ่งใน 3 อย่างนี้ = ไม่ออกจากฟังก์ชันนี้ */
    if (!p.evidence?.source_ids?.length || !p.expected_impact || !p.rollback?.target) return;
    out.push({ ...p, status: "pending", created_at: at });
  };

  /* ── ① กลุ่มที่โตขึ้นจนเข้าเกณฑ์ emerging → เสนอแก้ Persona ── */
  for (const c of weekly.changes) {
    if (c.bucket !== "emerging" || c.count < EMERGING_MIN) continue;

    const growing = c.delta > 0;
    push({
      id: idOf(["persona", c.signal, weekly.window.to]),
      type: "persona",
      priority: (GOAL_WEIGHT[c.signal] ?? 0) * 10 + c.count,
      title: `เพิ่ม "${label(c.signal)}" เป็น Persona กลุ่มที่ ${(persona?.codes?.length ?? 0) + 1}`,
      body: [
        `สัปดาห์นี้เจอ ${c.count} เคส (สัปดาห์ก่อน ${c.was} เคส${c.pct !== null ? ` · ${c.pct > 0 ? "+" : ""}${c.pct}%` : ""})`,
        growing ? "แนวโน้มเพิ่มขึ้น" : "ตัวเลขยังทรง ๆ — เกณฑ์ผ่านแต่ยังไม่โต",
        `ยังไม่อยู่ใน Persona ปัจจุบัน (${persona?.codes?.join(" · ") ?? "-"})`,
      ].join("\n"),
      evidence: { bucket: c.bucket, count: c.count, was: c.was, source_ids: c.source_ids },
      expected_impact: GOAL_WEIGHT[c.signal]
        ? "ตรงกับเป้าหมาย \"เจาะกลุ่มพนักงานออฟฟิศ\" — ถ้าเพิ่มเป็น Persona จะทำให้ข้อความ โปร และเวลาโพสต์ถูกออกแบบให้กลุ่มนี้ด้วย คาดว่าเพิ่มโอกาสปิดการขายของคำสั่งซื้อเป็นเซ็ต"
        : "ทำให้ร้านเห็นกลุ่มนี้ในรายงานทุกสัปดาห์ แทนที่จะถูกนับรวมเป็นอื่น ๆ",
      rollback: rollbackFor("persona-current.md", personaChecksum, gitRef),
    });
  }

  /* ── ② คำถามที่ตอบไม่ได้ซ้ำ ๆ → เสนอเพิ่ม FAQ ── */
  for (const q of weekly.unansweredThisWeek) {
    if (q.count < 2) continue;
    push({
      id: idOf(["faq", q.value]),
      type: "faq",
      priority: 50 + q.count,
      title: `เพิ่มคำตอบของ "${q.value}" ลงสมองร้าน`,
      body: [
        `สัปดาห์นี้มีคนถามซ้ำ ${q.count} ครั้ง แล้วระบบตอบไม่ได้ทุกครั้ง`,
        "ทุกครั้งที่ตอบไม่ได้คือครั้งที่ลูกค้าต้องรอคน หรือเลิกถามไปเลย",
      ].join("\n"),
      evidence: { bucket: "faq", count: q.count, source_ids: q.source_ids },
      expected_impact: "ลดเคสที่ต้องส่งต่อให้คน และลดเวลารอของลูกค้าในคำถามที่ตอบได้ด้วยข้อมูลที่ร้านมีอยู่แล้ว",
      rollback: rollbackFor("context.md", null, gitRef),
    });
  }

  /* ── ③ ข้อโต้แย้งที่เจอบ่อย → เสนอปรับสคริปต์ตอบ ── */
  for (const o of weekly.objectionsThisWeek) {
    if (o.count < EMERGING_MIN) continue;
    push({
      id: idOf(["script", o.value]),
      type: "script",
      priority: 40 + o.count,
      title: `ปรับสคริปต์ตอบเรื่อง "${o.value}"`,
      body: [
        `สัปดาห์นี้เจอ ${o.count} ครั้ง`,
        "ข้อโต้แย้งที่เจอซ้ำ ๆ แปลว่าคำตอบชุดปัจจุบันยังไม่ปิดประเด็นนี้ได้",
      ].join("\n"),
      evidence: { bucket: "objection", count: o.count, source_ids: o.source_ids },
      expected_impact: "ลดจำนวนครั้งที่ต้องส่งต่อให้เจ้าของร้านตัดสินใจเอง",
      rollback: rollbackFor("context.md", null, gitRef),
    });
  }

  /* ── ④ ช่วงเวลาที่ลูกค้าเข้ามาเยอะ → เสนอ Marketing Brief ── */
  const topBand = weekly.bandsThisWeek[0];
  if (topBand && topBand.count >= EMERGING_MIN) {
    const BAND_TH = { morning: "ช่วงเช้า", lunch: "ช่วงพักเที่ยง", after_school: "ช่วงเลิกเรียน", evening: "ช่วงค่ำ" };
    push({
      id: idOf(["brief", topBand.value, weekly.window.to]),
      type: "marketing_brief",
      priority: 30 + topBand.count,
      title: `ยิง ads เฉพาะ${BAND_TH[topBand.value] ?? topBand.value} แทนการยิงทั้งวัน`,
      body: [
        `สัปดาห์นี้ ${topBand.count} จาก ${weekly.thisWeek} เคสเข้ามาใน${BAND_TH[topBand.value] ?? topBand.value}`,
        "ยิงทั้งวันแปลว่าจ่ายค่าโฆษณาในชั่วโมงที่แทบไม่มีคนทัก",
      ].join("\n"),
      evidence: { bucket: "band", count: topBand.count, source_ids: topBand.source_ids },
      expected_impact: "ตรงกับเป้าหมาย \"ลดค่า ads\" — คาดว่าลดงบที่เสียไปในชั่วโมงที่ไม่มีคนทัก โดยยอดทักไม่ลด",
      rollback: rollbackFor("promotions.md", null, gitRef),
    });
  }

  return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}
