/*
 * เทสต์ Build Lab — Customer Intelligence
 *
 * ข้อที่ห้ามพลาดที่สุด 3 ข้อ:
 *   1. Lab รันบน production ไม่ได้
 *   2. Lab ไม่แก้ persona-current.md หรือสมองร้าน ไม่ว่าคำตัดสินจะเป็นอะไร
 *   3. ไม่มี PII หรือบทสนทนาดิบหลุดออกไปถึงสายตาเจ้าของร้าน
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateDemoEvents } from "../src/lab/demo-events.js";
import { REQUIRED_FIELDS, enrich, enrichAll, personaSignal, timeBand } from "../src/lab/enrich.js";
import {
  ALLOWED_EVENT_KEYS, LabRefused, assertStaging, labDir, privacyGate, redact, scanOutput, sweepLab,
} from "../src/lab/guard.js";
import { EMERGING_MIN, classifySignals, dailyInsight, weeklyComparison } from "../src/lab/insights.js";
import { DECISIONS, createLedger, isDecision } from "../src/lab/ledger.js";
import { personaFile, readPersona } from "../src/lab/persona.js";
import { buildProposals } from "../src/lab/proposals.js";
import { renderHtml, renderText } from "../src/lab/report.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lab-"));
const END = new Date("2026-09-16T12:00:00Z");
const DEMO = generateDemoEvents({ endDate: END });
const ROWS = enrichAll(DEMO);

/* ═══════════ ① Lab ต้องอยู่แต่ใน staging ═══════════ */

test("ไม่ตั้ง LAB_ENV=staging → รันไม่ได้", () => {
  for (const env of [{}, { LAB_ENV: "" }, { LAB_ENV: "production" }, { LAB_ENV: "rehearsal" }]) {
    assert.throws(() => assertStaging({ env }), LabRefused, `ต้องปฏิเสธ: ${JSON.stringify(env)}`);
  }
  assert.equal(assertStaging({ env: { LAB_ENV: "staging" } }), true);
});

test("เครื่องที่มี LINE token = เครื่องที่รับลูกค้าจริงได้ → รันไม่ได้", () => {
  for (const key of ["CHANNEL_ACCESS_TOKEN", "CHANNEL_SECRET"]) {
    assert.throws(() => assertStaging({ env: { LAB_ENV: "staging", [key]: "x" } }), LabRefused, `ต้องปฏิเสธเมื่อมี ${key}`);
  }
});

test("มีแอดมิน claim สิทธิ์อยู่ (โหมดใช้งานจริง) → รันไม่ได้", () => {
  const claims = { currentAdmin: () => "Uเจ้าของ000000000000000000000001" };
  assert.throws(() => assertStaging({ env: { LAB_ENV: "staging" }, claims }), LabRefused);
  assert.equal(assertStaging({ env: { LAB_ENV: "staging" }, claims: { currentAdmin: () => null } }), true);
});

test("ตัวที่รับลูกค้าจริงต้องไม่ import อะไรจาก src/lab/ เลย", () => {
  /*
   * ด่านที่สำคัญกว่าด่าน env ทั้งหมด — ถ้า production import โค้ด Lab เข้าไปแล้ว
   * ต่อให้ด่าน env กันการ "รัน" ไว้ ก็ยังมีโค้ดที่ไม่เคยถูกตรวจอยู่ในเส้นทางของลูกค้าจริง
   */
  const productionFiles = fs
    .readdirSync(path.join(ROOT, "src"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join("src", f));

  const offenders = [];
  for (const file of productionFiles) {
    const body = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (/from\s+["'][^"']*\/lab\//.test(body) || /from\s+["']\.\/lab\//.test(body)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `ไฟล์ production ที่ import Lab: ${offenders.join(", ")}`);
});

test("ผลลัพธ์ของ Lab อยู่นอก repo", () => {
  assert.ok(!path.resolve(labDir()).startsWith(ROOT + path.sep), `ต้องไม่อยู่ใน repo: ${labDir()}`);
});

/* ═══════════ ① Privacy Gate ═══════════ */

test("ชุดข้อมูลทดลองผ่าน Privacy Gate แบบ 0 finding", () => {
  const gate = privacyGate(DEMO);
  assert.deepEqual(gate.findings, []);
  assert.equal(gate.ok, true);
});

test("คีย์ที่ไม่อยู่ใน allowlist → ปฏิเสธทั้งชุด ไม่ใช่ตัดคีย์ทิ้งเงียบ ๆ", () => {
  const gate = privacyGate([{ id: "a", suffix: "abcd", customer_name: "สมชาย" }]);
  assert.equal(gate.ok, false);
  assert.ok(gate.findings.some((f) => f.why.includes("customer_name")));
});

test("PII ทุกแบบที่โจทย์สั่งให้ลบถูกจับ", () => {
  const cases = [
    ["เบอร์โทร", { id: "a", suffix: "abcd", handoff: "โทรกลับ 081-234-5678" }],
    ["ชื่อคน", { id: "a", suffix: "abcd", handoff: "คุณสมชาย ขอคุยเจ้าของ" }],
    ["LINE user id", { id: "a", suffix: "abcd", handoff: `U${"a1b2c3d4".repeat(4)}` }],
    ["อีเมล", { id: "a", suffix: "abcd", unanswered: "ส่งไปที่ a@b.co.th ได้ไหม" }],
    ["เลขบัตรประชาชน", { id: "a", suffix: "abcd", handoff: "1234567890123" }],
  ];
  for (const [name, record] of cases) {
    assert.equal(privacyGate([record]).ok, false, `ต้องจับ${name}ได้`);
  }
});

test("suffix ยาวเกิน 4 ตัว = มี id เต็มหลุดมา → ปฏิเสธ", () => {
  assert.equal(privacyGate([{ id: "a", suffix: "Uabcdef123456" }]).ok, false);
  assert.equal(privacyGate([{ id: "a", suffix: "abcd" }]).ok, true);
});

test("ข้อความยาวผิดปกติ = บทสนทนาดิบ → ปฏิเสธ", () => {
  const long = "ก".repeat(250);
  assert.equal(privacyGate([{ id: "a", suffix: "abcd", unanswered: long }]).ok, false);
});

test("คำถามร้านค้าปกติต้องไม่ถูกจับผิด", () => {
  /* ด่านที่เตือนผิดบ่อย ๆ จะถูกกดผ่านโดยไม่อ่าน แล้ววันที่มันเตือนถูกก็จะถูกกดผ่านด้วย */
  for (const q of [
    "ส่งต่างจังหวัดได้ไหม", "ร้านอยู่ถนนอะไรคะ", "มีสาขาอื่นไหมคะ",
    "ช่วง 2026-06-19 → 2026-09-16", "ยอด 2,950.00 บาท", "เวลา 18:30 น.", "demo-26-3, demo-89-4",
  ]) {
    assert.equal(scanOutput(q).ok, true, `ถูกจับผิด: ${q}`);
  }
});

test("redact ปิดบังชื่อและเบอร์ที่หลุดเข้ามา", () => {
  const out = redact("คุณสมชาย 081-234-5678 สั่ง 2 กล่อง");
  assert.ok(!/081/.test(out));
  assert.ok(!/สมชาย/.test(out));
  assert.match(out, /สั่ง 2 กล่อง/, "ข้อความที่ไม่ใช่ PII ต้องอยู่ครบ");
});

test("ลบผลลัพธ์ที่เกิน retention 15 วัน", () => {
  const dir = tmp();
  const old = path.join(dir, "old.txt");
  const recent = path.join(dir, "recent.txt");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(recent, "x");
  const past = new Date(Date.now() - 20 * 86400_000);
  fs.utimesSync(old, past, past);

  assert.equal(sweepLab({ dir, days: 15 }), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
});

/* ═══════════ ① ข้อมูลทดลอง ═══════════ */

test("ชุดข้อมูลทดลองให้ผลเหมือนเดิมทุกครั้ง", () => {
  const a = generateDemoEvents({ endDate: END });
  const b = generateDemoEvents({ endDate: END });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "รายงานที่เปลี่ยนไปมาทั้งที่ข้อมูลเท่าเดิม คือรายงานที่เชื่อไม่ได้");
});

test("ครอบคลุม 90 วัน และทุก record มีแต่คีย์ที่อนุญาต", () => {
  const days = new Set(DEMO.map((e) => e.at.slice(0, 10)));
  assert.ok(days.size >= 85, `ควรครอบคลุมเกือบ 90 วัน แต่ได้ ${days.size}`);
  for (const e of DEMO) {
    for (const k of Object.keys(e)) assert.ok(ALLOWED_EVENT_KEYS.has(k), `คีย์ต้องห้าม: ${k}`);
  }
});

/* ═══════════ ② 10 ฟิลด์ ═══════════ */

test("สรุปครบทั้ง 10 ฟิลด์ที่โจทย์กำหนด", () => {
  for (const row of ROWS.slice(0, 50)) {
    for (const f of REQUIRED_FIELDS) assert.ok(f in row, `ขาดฟิลด์ ${f}`);
  }
});

test("persona_signal อ่านจากพฤติกรรม ไม่ใช่เดาสุ่ม", () => {
  const base = { at: "2026-09-16T16:00:00+07:00", triggers: [] };
  assert.equal(personaSignal({ ...base, product: "brownie-piece" }), "student", "ของชิ้นเล็กตอนเลิกเรียน");
  assert.equal(personaSignal({ ...base, product: "box-set-1" }), "parent_pickup", "ของเป็นกล่องตอนเลิกเรียน");
  assert.equal(personaSignal({ at: "2026-09-16T12:00:00+07:00", product: "box-set-1", triggers: [] }), "office", "เซ็ตใหญ่ตอนพักเที่ยง");
  assert.equal(personaSignal({ at: "2026-09-16T12:00:00+07:00", product: null, triggers: ["delivery_appointment"] }), "office");
});

test("timeBand แบ่งช่วงตามจังหวะร้านหน้าโรงเรียน", () => {
  assert.equal(timeBand("2026-09-16T08:00:00+07:00"), "morning");
  assert.equal(timeBand("2026-09-16T12:30:00+07:00"), "lunch");
  assert.equal(timeBand("2026-09-16T16:00:00+07:00"), "after_school");
  assert.equal(timeBand("2026-09-16T20:00:00+07:00"), "evening");
});

test("outcome จับ 'คำถามที่ตอบไม่ได้' เป็นผลลัพธ์ของตัวเอง", () => {
  const r = enrich({ id: "x", at: "2026-09-16T10:00:00+07:00", suffix: "abcd", intent: "other", lead: "cold", unanswered: "มีสาขาไหม", triggers: [] });
  assert.equal(r.outcome, "unanswered");
  assert.equal(r.unanswered_question, "มีสาขาไหม");
});

/* ═══════════ ③ match / emerging / outlier ═══════════ */

const rowsFor = (signals) => signals.map((s, i) => ({ id: `e${i}`, persona_signal: s, date: "2026-09-16", suffix: "abcd" }));

test("เกณฑ์ 3 ถัง: match = ตรง Persona · emerging ≥ 3 เคส · outlier = เคสเดี่ยว", () => {
  const rows = rowsFor(["student", "student", "office", "office", "office", "event_organizer"]);
  const out = classifySignals(rows, { personaCodes: ["student", "parent_pickup"] });

  const by = Object.fromEntries(out.map((s) => [s.signal, s]));
  assert.equal(by.student.bucket, "match");
  assert.equal(by.office.bucket, "emerging");
  assert.equal(by.office.count, EMERGING_MIN);
  assert.equal(by.event_organizer.bucket, "outlier");
  assert.equal(by.event_organizer.count, 1);
});

test("2 เคส — ยังไม่ถึง emerging แต่ต้องไม่หายไปจากรายงาน", () => {
  const out = classifySignals(rowsFor(["office", "office"]), { personaCodes: [] });
  assert.equal(out[0].bucket, "outlier");
  assert.match(out[0].note, /อีก 1 เคสจะเข้าเกณฑ์ emerging/);
});

test("'unknown' ไม่ใช่กลุ่มลูกค้า → ห้ามถูกเสนอเป็น emerging", () => {
  const out = classifySignals(rowsFor(["unknown", "unknown", "unknown", "unknown"]), { personaCodes: [] });
  assert.equal(out[0].bucket, "unclassified", "ไม่งั้น Lab จะเสนอให้เพิ่ม Persona กลุ่ม unknown ซึ่งไม่มีความหมาย");
});

test("ทุกข้อสรุปมี evidence count และ source ids ติดมาด้วยเสมอ", () => {
  const out = classifySignals(rowsFor(["office", "office", "office"]), { personaCodes: [] });
  assert.equal(out[0].count, 3);
  assert.deepEqual(out[0].source_ids, ["e0", "e1", "e2"]);
});

test("daily insight นับจากวันนั้นวันเดียว", () => {
  const persona = { codes: ["student", "parent_pickup"] };
  const d = dailyInsight(ROWS, { date: "2026-09-16", persona });
  assert.equal(d.date, "2026-09-16");
  assert.equal(d.events, ROWS.filter((r) => r.date === "2026-09-16").length);
  assert.ok(d.signals.every((s) => s.count > 0));
});

test("weekly comparison เทียบ 7 วันล่าสุดกับ 7 วันก่อนหน้า และบอก delta", () => {
  const persona = { codes: ["student", "parent_pickup"] };
  const w = weeklyComparison(ROWS, { endDate: "2026-09-16", persona });

  assert.equal(w.window.to, "2026-09-16");
  assert.equal(w.window.from, "2026-09-10");
  assert.equal(w.previous.to, "2026-09-09");
  assert.ok(w.thisWeek > 0 && w.lastWeek > 0);
  for (const c of w.changes) assert.equal(c.delta, c.count - c.was, `delta ของ ${c.signal} ไม่ตรง`);
});

test("ฐานเล็กเกินไป → ไม่โชว์ % (กันเลขหลอกตาแบบ 1→3 = +200%)", () => {
  const rows = [
    ...rowsFor(["office"]).map((r) => ({ ...r, date: "2026-09-16" })),
    { id: "old", persona_signal: "office", date: "2026-09-05", suffix: "aaaa" },
  ];
  const w = weeklyComparison(rows, { endDate: "2026-09-16", persona: { codes: [] } });
  assert.equal(w.changes.find((c) => c.signal === "office").pct, null);
});

test("กลุ่มพนักงานออฟฟิศที่ซ่อนไว้ในข้อมูลทดลอง ต้องถูกหาเจอเป็น emerging", () => {
  /* ข้อมูลชุดนี้ถูกปั้นให้มีกลุ่ม office อยู่จริง — หาไม่เจอแปลว่าตัววิเคราะห์พัง ไม่ใช่ข้อมูลแปลก */
  const w = weeklyComparison(ROWS, { endDate: "2026-09-16", persona: readPersona() });
  const office = w.changes.find((c) => c.signal === "office");
  assert.ok(office, "ต้องเจอกลุ่ม office");
  assert.equal(office.bucket, "emerging");
  assert.ok(office.count >= EMERGING_MIN);
});

/* ═══════════ ④ ข้อเสนอ ═══════════ */

const proposalsFixture = () => {
  const persona = readPersona();
  const w = weeklyComparison(ROWS, { endDate: "2026-09-16", persona });
  const d = dailyInsight(ROWS, { date: "2026-09-16", persona });
  return { persona, proposals: buildProposals({ weekly: w, daily: d, persona, gitRef: "abc1234" }) };
};

test("ทุกข้อเสนอมี source ids · ผลที่คาด · rollback pointer ครบ", () => {
  const { proposals } = proposalsFixture();
  assert.ok(proposals.length > 0, "ควรมีข้อเสนออย่างน้อย 1 ใบจากข้อมูลชุดนี้");

  for (const p of proposals) {
    assert.ok(p.evidence.source_ids.length > 0, `${p.id} ไม่มี source ids`);
    assert.ok(p.evidence.count > 0, `${p.id} ไม่มี evidence count`);
    assert.ok(p.expected_impact, `${p.id} ไม่มีผลที่คาด`);
    assert.ok(p.rollback.target, `${p.id} ไม่มี rollback pointer`);
    assert.match(p.rollback.method, /git/, `${p.id} rollback ต้องบอกวิธีถอยจริง`);
    assert.equal(p.status, "pending", `${p.id} ต้องเริ่มที่ pending เสมอ`);
  }
});

test("source ids เป็น pseudonymous ไม่ใช่ id ลูกค้า", () => {
  const { proposals } = proposalsFixture();
  for (const p of proposals) {
    for (const id of p.evidence.source_ids) {
      assert.match(id, /^demo-\d+-\d+$/, `source id ต้องเป็นรหัสเคส ไม่ใช่ id คน: ${id}`);
    }
  }
});

test("ข้อเสนอครอบคลุมทั้ง Persona / FAQ / Script / Marketing Brief", () => {
  const { proposals } = proposalsFixture();
  const types = new Set(proposals.map((p) => p.type));
  assert.ok(types.has("persona"), "ควรมีข้อเสนอแก้ Persona");
  assert.ok(types.has("script") || types.has("faq"), "ควรมีข้อเสนอฝั่งคำตอบ");
  assert.ok(types.has("marketing_brief"), "ควรมี Marketing Brief");
});

test("ข้อเสนอที่ขาดหลักฐานถูกตัดทิ้ง ไม่โผล่ในรายงาน", () => {
  const empty = buildProposals({
    weekly: { changes: [{ signal: "ghost", bucket: "emerging", count: 5, was: 0, delta: 5, pct: null, source_ids: [] }],
      unansweredThisWeek: [], objectionsThisWeek: [], bandsThisWeek: [], window: { to: "2026-09-16" }, thisWeek: 5 },
    daily: {}, persona: { codes: [], checksum: "x" },
  });
  assert.deepEqual(empty, [], "ไม่มี source ids = ไม่ออกจากตัวสร้างข้อเสนอ");
});

test("ข้อเสนอที่ตรงเป้าหมายธุรกิจถูกจัดขึ้นบน", () => {
  const { proposals } = proposalsFixture();
  const persona = proposals.find((p) => p.type === "persona");
  assert.match(persona.expected_impact, /เจาะกลุ่มพนักงานออฟฟิศ/, "ควรผูกกับเป้าหมายที่ร้านตั้งไว้");
});

/* ═══════════ ⑤ Approve / Reject / Observe ═══════════ */

const ledgerRig = () => {
  const dir = tmp();
  const { proposals } = proposalsFixture();
  return { dir, ledger: createLedger({ dir }), proposal: proposals[0], proposals };
};

test("มีคำตัดสินครบ 3 แบบ และไม่รับแบบอื่น", () => {
  assert.deepEqual(Object.keys(DECISIONS), ["approve", "reject", "observe"]);
  assert.equal(isDecision("deploy"), false);
  const { ledger, proposal } = ledgerRig();
  assert.equal(ledger.decide(proposal, "deploy").ok, false);
});

test("ทุกคำตัดสินบันทึก applied:false — Lab ไม่แก้ไฟล์เอง", () => {
  const { ledger, proposals } = ledgerRig();
  for (const [i, d] of ["approve", "reject", "observe"].entries()) {
    const res = ledger.decide(proposals[i], d);
    assert.equal(res.applied, false, `${d} ต้องไม่แก้ไฟล์`);
  }
  assert.equal(ledger.all().every((r) => r.applied === false), true);
});

test("Reject → persona-current.md ต้องไม่เปลี่ยนแม้แต่ไบต์เดียว", () => {
  const before = crypto.createHash("sha256").update(fs.readFileSync(personaFile())).digest("hex");
  const { ledger, proposals } = ledgerRig();
  const personaProposal = proposals.find((p) => p.type === "persona");

  const res = ledger.decide(personaProposal, "reject");

  assert.equal(res.status, "rejected");
  const after = crypto.createHash("sha256").update(fs.readFileSync(personaFile())).digest("hex");
  assert.equal(after, before, "ไฟล์ Persona ต้องไม่ถูกแตะ");
});

test("Observe another week → คงสถานะรอดู ไม่ deploy", () => {
  const { ledger, proposal } = ledgerRig();
  const res = ledger.decide(proposal, "observe");

  assert.equal(res.status, "observing");
  assert.equal(res.applied, false);
  assert.deepEqual(res.next_steps, [], "observe ต้องไม่มีขั้นตอนให้ไปทำ");
  assert.equal(ledger.statusOf(proposal.id), "observing");
  assert.equal(DECISIONS.observe.terminal, false, "ยังไม่ใช่คำตัดสินสุดท้าย");
});

test("Approve = รับเรื่องไว้ ไม่ใช่ทำเลย — ต้องบอกขั้นตอนที่คนต้องไปทำ", () => {
  const before = crypto.createHash("sha256").update(fs.readFileSync(personaFile())).digest("hex");
  const { ledger, proposals } = ledgerRig();
  const personaProposal = proposals.find((p) => p.type === "persona");

  const res = ledger.decide(personaProposal, "approve");

  assert.equal(res.status, "approved");
  assert.equal(res.applied, false, "Approve ก็ยังห้ามแก้ไฟล์เอง");
  assert.ok(res.next_steps.length >= 3, "ต้องบอกขั้นตอนให้คนทำตามได้จริง");
  assert.ok(res.next_steps.some((s) => s.includes("persona-current.md")));
  assert.ok(res.next_steps.some((s) => s.includes("git")), "ต้องมีวิธีถอยกลับ");

  const after = crypto.createHash("sha256").update(fs.readFileSync(personaFile())).digest("hex");
  assert.equal(after, before, "แม้ Approve ไฟล์ก็ต้องไม่เปลี่ยน");
});

test("เปลี่ยนใจได้ และเห็นประวัติเดิมครบ", () => {
  const { ledger, proposal } = ledgerRig();
  ledger.decide(proposal, "observe");
  ledger.decide(proposal, "approve");

  assert.equal(ledger.statusOf(proposal.id), "approved");
  assert.equal(ledger.all().filter((r) => r.proposal_id === proposal.id).length, 2, "ประวัติเดิมต้องไม่ถูกทับ");
});

test("คำตัดสินเก็บ rollback pointer ติดไปด้วย", () => {
  const { ledger, proposals } = ledgerRig();
  const p = proposals.find((x) => x.type === "persona");
  ledger.decide(p, "approve");
  const rec = ledger.latest(p.id);

  assert.equal(rec.rollback.target, "persona-current.md");
  assert.ok(rec.source_ids.length > 0, "วันที่จะถอยจะได้ไม่ต้องไปตามหาในรายงานเก่า");
});

test("ยังไม่เคยตัดสิน → pending", () => {
  const { ledger } = ledgerRig();
  assert.equal(ledger.statusOf("prop-ไม่มีจริง"), "pending");
});

/* ═══════════ ⑥ รายงาน ═══════════ */

const reportFixture = () => {
  const { persona, proposals } = proposalsFixture();
  const daily = dailyInsight(ROWS, { date: "2026-09-16", persona });
  const weekly = weeklyComparison(ROWS, { endDate: "2026-09-16", persona });
  const meta = { from: "2026-06-19", to: "2026-09-16", days: 90, events: ROWS.length, source: "demo (pseudonymous)" };
  return { daily, weekly, proposals, persona, meta };
};

test("รายงานผ่าน privacy scan แบบศูนย์ ทั้งข้อความและ HTML", () => {
  const f = reportFixture();
  const text = renderText(f);
  const html = renderHtml(f);

  assert.deepEqual(scanOutput(text).findings, [], "รายงานข้อความมี PII");
  assert.deepEqual(scanOutput(html).findings, [], "รายงาน HTML มี PII");
});

test("รายงานไม่มีบทสนทนาดิบและไม่มี LINE user id", () => {
  const text = renderText(reportFixture());
  assert.ok(!/\bU[0-9a-f]{32}\b/.test(text));
  /* ข้อความยาว ๆ ที่ไม่ใช่หัวข้อ = บทสนทนาดิบหลุดมา */
  for (const line of text.split("\n")) {
    assert.ok(line.length < 260, `บรรทัดยาวผิดปกติ: ${line.slice(0, 60)}…`);
  }
});

test("รายงานโชว์ evidence count ติดกับทุกข้อสรุป", () => {
  const f = reportFixture();
  const text = renderText(f);
  for (const s of f.daily.signals) {
    assert.ok(text.includes(`${s.signal.padEnd(16)} ${s.count} เคส`), `ขาด evidence count ของ ${s.signal}`);
  }
  for (const p of f.proposals) {
    assert.ok(text.includes(`หลักฐาน: ${p.evidence.count} เคส`), `ข้อเสนอ ${p.id} ไม่โชว์ evidence count`);
  }
});

test("รายงานบอกชัดว่าทุกข้อเสนอรอ Approve และยังไม่มีไฟล์ไหนถูกแก้", () => {
  const f = reportFixture();
  assert.match(renderText(f), /รอ Approve/);
  assert.match(renderText(f), /ยังไม่มีไฟล์ไหนของร้านถูกแก้|รอ Approve ก่อนถึงจะมีใครไปแก้ของจริง/);
  assert.match(renderHtml(f), /ยังไม่มีไฟล์ของร้านไฟล์ไหนถูกแก้/);
});

test("HTML อ่านบนมือถือได้ — ไม่มี script และไม่มีปุ่มที่กดแล้วเกิดผลจริง", () => {
  const html = renderHtml(reportFixture());
  assert.ok(!/<script/i.test(html), "หน้ารายงานต้องไม่มีสคริปต์");
  assert.ok(!/<form|<button|onclick=/i.test(html), "ปุ่มที่กดแล้วแก้ Persona ได้เลยคือสิ่งที่โจทย์ห้าม");
  assert.match(html, /prefers-color-scheme/, "ต้องอ่านได้ทั้งโหมดสว่างและมืด");
  assert.match(html, /<title>/, "ต้องมีชื่อหน้า");
});

test("สถานะของข้อเสนอในรายงานอ่านจากสมุดตัดสินใจจริง", () => {
  const f = reportFixture();
  const ledger = createLedger({ dir: tmp() });
  ledger.decide(f.proposals[0], "observe");

  const html = renderHtml({ ...f, ledger });
  assert.match(html, /รอดูอีก 1 สัปดาห์/);
  assert.match(renderText({ ...f, ledger }), /รอดูอีก 1 สัปดาห์/);
});
