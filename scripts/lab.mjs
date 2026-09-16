/*
 * Build Lab CLI — Customer Intelligence (staging เท่านั้น)
 *
 *   LAB_ENV=staging npm run lab -- run
 *   LAB_ENV=staging npm run lab -- decide <proposal-id> approve|reject|observe
 *   LAB_ENV=staging npm run lab -- status
 *
 * ทุกคำสั่งผ่าน assertStaging() ก่อนเสมอ — รันบนเครื่องที่มี LINE token ไม่ได้
 * และไม่มีไฟล์ไหนใน src/lab/ ถูก import จาก src/server.js (มีเทสต์กวาดไว้)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { LabRefused, assertStaging, labDir, privacyGate, scanOutput, sweepLab, RETENTION_DAYS } from "../src/lab/guard.js";
import { generateDemoEvents } from "../src/lab/demo-events.js";
import { enrichAll } from "../src/lab/enrich.js";
import { readPersona } from "../src/lab/persona.js";
import { dailyInsight, weeklyComparison } from "../src/lab/insights.js";
import { buildProposals } from "../src/lab/proposals.js";
import { createLedger, DECISIONS, isDecision } from "../src/lab/ledger.js";
import { renderHtml, renderText } from "../src/lab/report.js";

const [command, ...rest] = process.argv.slice(2);

try {
  assertStaging();
} catch (err) {
  if (err instanceof LabRefused) {
    console.error(`\n🚫 ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

const DIR = labDir();
const ANALYSIS_DAYS = Number(process.env.LAB_DAYS) || 90;

const gitRef = () => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const proposalsFile = () => path.join(DIR, "proposals.json");

const loadProposals = () => {
  try {
    return JSON.parse(fs.readFileSync(proposalsFile(), "utf8"));
  } catch {
    return [];
  }
};

function runLab() {
  const now = new Date();

  /*
   * ── ① ข้อมูลเข้า ──
   * demo เท่านั้น ไม่มีโค้ดบรรทัดไหนในไฟล์นี้ที่อ่าน ~/shop-data/customer-events ของจริง
   * ถ้าวันหนึ่งจะใช้ข้อมูลจริง ต้องเขียนทางเข้าใหม่และให้มันผ่าน privacyGate ก่อนเหมือนกัน
   */
  const events = generateDemoEvents({ days: ANALYSIS_DAYS, endDate: now });

  /* ── ② Privacy Gate — ก่อนแตะข้อมูลเลยด้วยซ้ำ ── */
  const gate = privacyGate(events);
  if (!gate.ok) {
    console.error(`\n🚫 Privacy Gate ไม่ผ่าน ${gate.findings.length} ข้อ — ไม่วิเคราะห์ต่อ`);
    for (const f of gate.findings.slice(0, 10)) console.error(`   ${f.where}: ${f.why}`);
    process.exit(3);
  }

  /* ── ③ วิเคราะห์ ── */
  const rows = enrichAll(events);
  const persona = readPersona();
  const today = rows.at(-1)?.date ?? new Date().toISOString().slice(0, 10);

  const daily = dailyInsight(rows, { date: today, persona });
  const weekly = weeklyComparison(rows, { endDate: today, persona });
  const proposals = buildProposals({ weekly, daily, persona, gitRef: gitRef(), now: () => now });

  const ledger = createLedger({ dir: DIR });
  ledger.ensure();

  const meta = {
    from: rows[0]?.date,
    to: today,
    days: ANALYSIS_DAYS,
    events: rows.length,
    source: "demo (pseudonymous)",
  };

  /* ── ④ Privacy scan ของ "ของที่จะออกไป" ก่อนส่งให้เจ้าของดู ── */
  const text = renderText({ daily, weekly, proposals, persona, ledger, meta });
  const scan = scanOutput(text);
  if (!scan.ok) {
    console.error(`\n🚫 privacy scan เจอ ${scan.findings.length} ข้อในรายงาน — ไม่เขียนไฟล์`);
    for (const f of scan.findings) console.error(`   ${f.why} (${f.sample})`);
    process.exit(4);
  }
  meta.scan = `(${scan.findings.length} finding)`;

  /* ── ⑤ เขียนผลลัพธ์ — นอก repo เสมอ ── */
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);

  /* ข้อเสนอเก่าที่เคยตัดสินไปแล้ว ต้องไม่ถูกรีเซ็ตกลับเป็น pending */
  const merged = proposals.map((p) => ({ ...p, status: ledger.statusOf(p.id) }));

  const html = renderHtml({ daily, weekly, proposals: merged, persona, ledger, meta });
  const htmlScan = scanOutput(html);

  const out = {
    "proposals.json": JSON.stringify(merged, null, 2),
    "report.txt": text,
    "report.html": html,
    "analysis.json": JSON.stringify({ meta, daily, weekly }, null, 2),
  };
  for (const [name, body] of Object.entries(out)) {
    fs.writeFileSync(path.join(DIR, name), body, { mode: 0o600 });
  }

  const removed = sweepLab({ dir: DIR, days: RETENTION_DAYS });

  console.log(text);
  console.log("");
  console.log(`📁 ผลลัพธ์: ${DIR}`);
  console.log(`   report.html  เปิดบนมือถือได้`);
  console.log(`🔒 privacy scan: ข้อมูลเข้า ${gate.findings.length} finding · รายงาน ${scan.findings.length} finding · HTML ${htmlScan.findings.length} finding`);
  console.log(`🧹 เก็บผลไว้ ${RETENTION_DAYS} วัน${removed ? ` (ลบของเก่าไป ${removed} รายการ)` : ""}`);
  console.log(`\n⚠️  ยังไม่มีไฟล์ไหนของร้านถูกแก้ ทุกข้อเสนอรอ Approve`);
}

function decide() {
  const [proposalId, decision] = rest;
  if (!proposalId || !isDecision(decision)) {
    console.error(`\nใช้: npm run lab -- decide <proposal-id> ${Object.keys(DECISIONS).join("|")}\n`);
    process.exit(1);
  }

  const proposal = loadProposals().find((p) => p.id === proposalId);
  if (!proposal) {
    console.error(`\n❌ ไม่พบข้อเสนอ ${proposalId} — รัน "npm run lab -- run" ก่อน\n`);
    process.exit(1);
  }

  const ledger = createLedger({ dir: DIR });
  const res = ledger.decide(proposal, decision);
  if (!res.ok) {
    console.error(`\n❌ ${res.error}\n`);
    process.exit(1);
  }

  /* อัปเดตสถานะในไฟล์ข้อเสนอ — ไฟล์นี้อยู่ใน ~/shop-lab ไม่ใช่ไฟล์ของร้าน */
  const all = loadProposals().map((p) => (p.id === proposalId ? { ...p, status: res.status } : p));
  fs.writeFileSync(proposalsFile(), JSON.stringify(all, null, 2), { mode: 0o600 });

  console.log(`\n${DECISIONS[decision].label} — ${proposal.title}`);
  console.log(`   ${res.effect}`);
  console.log(`   สถานะตอนนี้: ${res.status} · applied: ${res.applied}`);

  if (res.next_steps.length) {
    console.log(`\n   ขั้นตอนที่ "คน" ต้องไปทำเอง:`);
    res.next_steps.forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
  }
  console.log("");
}

function status() {
  const ledger = createLedger({ dir: DIR });
  const proposals = loadProposals();
  const persona = readPersona();

  console.log(`\n📋 Build Lab — ${DIR}`);
  console.log(`   Persona ปัจจุบัน : ${persona.codes.join(" · ") || "-"}`);
  console.log(`   checksum        : ${persona.checksum?.slice(0, 12) ?? "-"}  (ใช้พิสูจน์ว่าไฟล์ไม่ถูกแตะ)`);
  console.log(`   ข้อเสนอทั้งหมด   : ${proposals.length} ใบ`);

  const byStatus = {};
  for (const p of proposals) {
    const s = ledger.statusOf(p.id);
    (byStatus[s] ??= []).push(p);
  }
  for (const [s, list] of Object.entries(byStatus)) {
    console.log(`\n   ${s} (${list.length})`);
    for (const p of list) console.log(`     ${p.id}  ${p.title}`);
  }

  const applied = ledger.all().filter((d) => d.applied);
  console.log(`\n   คำตัดสินที่แก้ไฟล์จริงไปแล้ว: ${applied.length} (ต้องเป็น 0 เสมอ — Lab ไม่แก้ไฟล์เอง)`);
  console.log("");
}

switch (command) {
  case "run":
    runLab();
    break;
  case "decide":
    decide();
    break;
  case "status":
    status();
    break;
  default:
    console.log(`
Build Lab — Customer Intelligence (staging เท่านั้น)

  run                              วิเคราะห์ demo event แล้วออกรายงาน + ข้อเสนอ
  decide <proposal-id> <คำตัดสิน>  ${Object.keys(DECISIONS).join(" | ")}
  status                           ดูสถานะข้อเสนอและ checksum ของ persona-current.md

ต้องตั้ง LAB_ENV=staging · ผลลัพธ์อยู่นอก repo ที่ ${labDir()}
Lab ไม่แก้ persona-current.md และไม่แก้สมองร้านเอง ไม่ว่ากรณีใด
`);
    process.exit(command ? 1 : 0);
}
