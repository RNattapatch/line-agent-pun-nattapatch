/*
 * สมุดตัดสินใจ — Approve · Reject · Observe another week
 *
 * ═══ ไฟล์นี้ไม่มีโค้ดที่เขียนทับไฟล์ของร้านเลยแม้แต่บรรทัดเดียว ═══
 * "Approve" ที่นี่แปลว่า **รับเรื่องไว้ให้คนไปทำ** ไม่ใช่ "ทำเลย"
 *
 * ถ้าปล่อยให้ Approve แล้วแก้ไฟล์เองอัตโนมัติ วันหนึ่งจะมีคนกดพลาดตอนอ่านบนมือถือ
 * แล้ว Persona ของร้านก็เปลี่ยนไปโดยที่ไม่มีใครตั้งใจ — ของแบบนั้นต้องมีคนพิมพ์แก้เอง
 * ให้รู้ตัวว่ากำลังทำอะไรอยู่
 *
 * สิ่งที่ Approve ทำจริง ๆ มีอย่างเดียว: บันทึกว่าเจ้าของร้านเห็นชอบ
 * แล้วพิมพ์ "ขั้นตอนที่คนต้องไปทำต่อ" ออกมาให้ พร้อม rollback pointer
 */

import fs from "node:fs";
import path from "node:path";

import { labDir } from "./guard.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const DECISIONS = {
  approve: {
    id: "approve",
    label: "Approve",
    /* ย้ำในตัวข้อความเองว่ายังไม่มีอะไรถูกแก้ */
    effect: "รับเรื่องไว้แล้ว — ยังไม่มีไฟล์ไหนถูกแก้ ต้องมีคนไปแก้เองตามขั้นตอนข้างล่าง",
    terminal: true,
  },
  reject: {
    id: "reject",
    label: "Reject",
    effect: "ปิดเรื่อง ไม่ทำ — ไม่มีไฟล์ไหนถูกแตะ",
    terminal: true,
  },
  observe: {
    id: "observe",
    label: "Observe another week",
    effect: "ยังไม่ตัดสิน รอดูอีก 1 สัปดาห์ — ข้อเสนอคงอยู่ในสถานะรอดู ไม่ deploy",
    terminal: false,
  },
};

export const isDecision = (id) => Object.hasOwn(DECISIONS, String(id));

/* สถานะของข้อเสนอหลังตัดสินใจ */
const STATUS_OF = { approve: "approved", reject: "rejected", observe: "observing" };

export function createLedger({ dir = labDir(), now = () => new Date() } = {}) {
  const file = path.join(dir, "decisions.jsonl");

  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    return dir;
  };

  const readAll = () => {
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  };

  return {
    dir,
    file,
    ensure,
    all: readAll,

    /* คำตัดสินล่าสุดของข้อเสนอนั้น — null ถ้ายังไม่เคยตัดสิน */
    latest(proposalId) {
      const rows = readAll().filter((r) => r.proposal_id === proposalId);
      return rows.length ? rows.at(-1) : null;
    },

    /* สถานะปัจจุบันของข้อเสนอ — pending ถ้ายังไม่เคยมีใครตัดสิน */
    statusOf(proposalId) {
      return this.latest(proposalId)?.status ?? "pending";
    },

    /*
     * บันทึกคำตัดสิน — append อย่างเดียว ไม่ทับของเดิม
     * เปลี่ยนใจได้ (observe → approve) และยังเห็นประวัติเดิมครบ
     *
     * คืน { ok, status, next_steps } · next_steps คือสิ่งที่ "คน" ต้องไปทำ
     * ไม่ใช่สิ่งที่โปรแกรมจะทำให้
     */
    decide(proposal, decision, { actor = "owner", note = null } = {}) {
      if (!isDecision(decision)) return { ok: false, error: `ไม่รู้จักคำตัดสิน "${decision}"` };
      if (!proposal?.id) return { ok: false, error: "ไม่มีข้อเสนอให้ตัดสิน" };

      ensure();
      const status = STATUS_OF[decision];
      const record = {
        at: now().toISOString(),
        proposal_id: proposal.id,
        proposal_type: proposal.type,
        proposal_title: proposal.title,
        decision,
        status,
        actor,
        note,
        /* เก็บ rollback pointer ติดไปกับคำตัดสินด้วย — วันที่จะถอยจะได้ไม่ต้องไปตามหาในรายงานเก่า */
        rollback: proposal.rollback ?? null,
        evidence_count: proposal.evidence?.count ?? null,
        source_ids: proposal.evidence?.source_ids ?? [],
        /* ย้ำลงไฟล์เลยว่าไม่มีอะไรถูกแก้ตอนกดปุ่ม */
        applied: false,
      };

      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
      try {
        fs.chmodSync(file, FILE_MODE);
      } catch {
        /* ไฟล์เพิ่งถูกกวาดทิ้ง */
      }

      return {
        ok: true,
        status,
        applied: false,
        effect: DECISIONS[decision].effect,
        next_steps: decision === "approve" ? approveSteps(proposal) : [],
      };
    },
  };
}

/*
 * ขั้นตอนที่คนต้องไปทำเองหลังกด Approve
 * เขียนให้ทำตามได้ทีละบรรทัดจริง ๆ ไม่ใช่ "ไปแก้ persona ให้หน่อย"
 */
function approveSteps(proposal) {
  const target = proposal.rollback?.target ?? "(ไม่ระบุไฟล์)";
  return [
    `เปิด ${target} แล้วแก้ด้วยมือตามหัวข้อ: ${proposal.title}`,
    "อ่านหลักฐานประกอบในรายงานก่อนแก้ — ตัวเลขมาจากกี่เคส และมาจากเคสไหนบ้าง",
    `commit แยกใบเดียวให้ย้อนกลับง่าย แล้วอ้างอิงเลขข้อเสนอ ${proposal.id} ใน commit message`,
    `ถ้าทำแล้วผลแย่ลง: ${proposal.rollback?.method ?? "ถอยด้วย git revert"}`,
  ];
}
