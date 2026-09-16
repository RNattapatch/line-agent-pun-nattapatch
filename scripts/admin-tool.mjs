/*
 * เครื่องมือผู้ดูแล — ออกรหัส claim · ถอนสิทธิ์ · ดูสถานะ
 *
 * รันบนเครื่องที่บอทรันอยู่เท่านั้น (บน VPS ใช้ docker exec) เพราะต้องอ่าน-เขียน
 * ไฟล์สถานะใน ~/shop-data/admin ซึ่งเป็นโฟลเดอร์ 700 ของ user ที่รันบอท
 *
 * ═══ รหัสไม่เคยผ่าน argv ═══
 * เครื่องมือนี้ "สร้าง" รหัสเอง ไม่มีคำสั่งไหนรับรหัสเป็นพารามิเตอร์
 * รหัสจึงไม่เคยโผล่ใน `ps aux` (user อื่นบนเครื่องเดียวกันอ่าน argv ของเราได้)
 * และไม่เคยเข้า history ของ shell
 *
 * ═══ รหัสพิมพ์ออก stdout ครั้งเดียว ═══
 * ไม่เขียนลงไฟล์ ไม่เข้า log ไม่มีคำสั่ง "ขอดูรหัสเดิมอีกที" — ถ้าพลาดให้ออกใบใหม่
 * เตือนไว้ด้วยว่าอย่าถ่ายจอ เพราะรูปหน้าจอเป็นสิ่งที่หลุดเข้าแชทกลุ่มได้ง่ายที่สุด
 *
 *   docker exec -it line-agent-line-agent-1 node scripts/admin-tool.mjs issue
 *   docker exec -it line-agent-line-agent-1 node scripts/admin-tool.mjs status
 *   docker exec -it line-agent-line-agent-1 node scripts/admin-tool.mjs revoke-admin
 */

import { TTL_MINUTES, adminClaims } from "../src/admin-claim.js";
import { FAULTS, FAULT_TTL_MS, createFaultBox } from "../src/faults.js";
import { createReports } from "../src/reports.js";

const [command, faultArg] = process.argv.slice(2);

/* คำสั่ง fault รับชื่อ fault ได้ 1 ตัว — คำสั่งอื่นห้ามมีพารามิเตอร์ (กันรหัสหลุดเข้า argv) */
const TAKES_ARG = new Set(["fault"]);

/*
 * กันพลาดแบบที่เจ็บที่สุด: มีคนเผลอพิมพ์รหัสต่อท้ายคำสั่ง
 * ถ้าเกิดขึ้นแปลว่ารหัสนั้นอยู่ใน shell history และใน argv ไปแล้ว ถือว่าเสียแล้ว
 * ต้องบอกให้รู้ตัวทันที ไม่ใช่ปล่อยผ่านเพราะ "คำสั่งก็ยังทำงานได้อยู่"
 */
if (process.argv.length > 3 && !TAKES_ARG.has(command)) {
  console.error("❌ คำสั่งนี้ไม่รับพารามิเตอร์เพิ่ม");
  console.error("   ถ้าเพิ่งพิมพ์รหัสต่อท้ายไป รหัสนั้นอยู่ใน shell history แล้ว");
  console.error("   ให้ถือว่ารหัสนั้นใช้ไม่ได้ แล้วออกใบใหม่ด้วย: admin-tool.mjs issue");
  process.exit(1);
}

const thaiTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())} น.`;
};

function showStatus() {
  const s = adminClaims.status();
  const reports = createReports({ push: async () => {} });

  console.log("\n📋 สถานะสิทธิ์ผู้ดูแล");
  console.log(`   แอดมินตอนนี้   : ${s.hasAdmin ? `มี (LINE user ลงท้าย …${s.adminSuffix})` : "ยังไม่มีใคร claim"}`);
  if (s.claimedAt) console.log(`   claim เมื่อ     : ${thaiTime(s.claimedAt)}`);
  console.log(`   รหัสที่ยังใช้ได้ : ${s.pendingCode ? `มี · เหลืออีก ${Math.ceil(s.pendingCode.secondsLeft / 60)} นาที` : "ไม่มี"}`);
  console.log(`   ปลายทางรายงาน  : deliver=${reports.deliverMode()}`);
  console.log(`   รายงานค้างคิว   : ${reports.spoolSize()} ชิ้น`);

  if (s.history.length) {
    console.log("\n   ร่องรอยล่าสุด (ไม่มีรหัสและไม่มี userId เต็ม):");
    for (const h of s.history) {
      const extra = h.user_suffix ? ` user …${h.user_suffix}` : "";
      console.log(`     ${thaiTime(h.at)}  ${h.event}${extra}`);
    }
  }
  console.log();
}

switch (command) {
  case "issue": {
    const { code, expiresAt } = adminClaims.issue();

    console.log("\n🔑 รหัส claim สิทธิ์ผู้ดูแล (แสดงครั้งเดียว ไม่มีทางเรียกดูซ้ำ)\n");
    /* เว้นวรรคทุก 4 ตัวให้อ่านจากจอไปพิมพ์ในมือถือได้ไม่หลง — ตัวตรวจตัดเว้นวรรคออกให้เอง */
    console.log(`     ${code.match(/.{1,4}/g).join(" ")}\n`);
    console.log(`   หมดอายุ ${thaiTime(expiresAt)} (อีก ${TTL_MINUTES} นาที)`);
    console.log("   วิธีใช้ : พิมพ์รหัสนี้ส่งเข้าแชท LINE ของร้านจากบัญชีที่จะให้เป็นแอดมิน");
    console.log("   ใช้ได้ครั้งเดียว · ใช้แล้วหรือหมดอายุแล้วต้องออกใบใหม่");
    console.log("\n   ⚠️  อย่าถ่ายจอ อย่าคัดลอกไปวางในแชทกลุ่ม และอย่าพิมพ์ต่อท้ายคำสั่งใด ๆ");
    console.log("   ⚠️  เคลียร์จอเมื่อพิมพ์เสร็จ:  clear\n");
    break;
  }

  case "revoke-admin": {
    const { had } = adminClaims.revoke({ actor: "operator" });
    const reports = createReports({ push: async () => {} });
    console.log(had ? "\n🚫 ถอนสิทธิ์ผู้ดูแลแล้ว" : "\n🚫 ไม่มีแอดมินอยู่ก่อนหน้า (สั่งซ้ำได้ ไม่มีผลข้างเคียง)");
    console.log("   รหัสที่ยังค้างอยู่ถูกยกเลิกไปด้วย");
    console.log(`   ปลายทางรายงานกลับเป็น deliver=${reports.deliverMode()}`);
    console.log("   บัญชีเดิมกลับไปเป็นลูกค้าปกติ (Customer Test)\n");
    break;
  }

  case "status":
    showStatus();
    break;

  /*
   * สวิตช์จำลองความพัง — สำหรับ Customer Test เท่านั้น
   * ดูเหตุผลของด่านทั้ง 4 ชั้นใน src/faults.js
   */
  case "fault": {
    const box = createFaultBox({ claims: adminClaims });

    if (!faultArg || faultArg === "status") {
      const st = box.status();
      console.log("\n🧪 ตัวจำลองความพัง");
      console.log(`   เปิดใช้ได้ไหม : ${st.allowed ? "ได้ (ตั้ง ALLOW_FAULT_INJECTION=1 ไว้)" : "ไม่ได้ — ต้องตั้ง ALLOW_FAULT_INJECTION=1"}`);
      console.log(`   มีแอดมินอยู่  : ${st.blockedByAdmin ? "มี → เปิดไม่ได้ (โหมดใช้งานจริง)" : "ไม่มี"}`);
      console.log(`   เปิดอยู่ตอนนี้ : ${st.active ? `${st.active} (เหลือ ${st.secondsLeft} วิ)` : "ไม่มี (ปิดอยู่)"}`);
      console.log("\n   แบบที่เลือกได้:");
      for (const [id, label] of Object.entries(FAULTS)) console.log(`     ${id.padEnd(12)} ${label}`);
      console.log(`\n   เปิด: admin-tool.mjs fault <ชื่อ>   ·   ปิด: admin-tool.mjs fault off`);
      console.log(`   เปิดแล้วดับเองใน ${FAULT_TTL_MS / 60000} นาที\n`);
      break;
    }

    if (faultArg === "off") {
      const { had } = box.disable();
      console.log(had ? `\n🧪 ปิด fault "${had}" แล้ว\n` : "\n🧪 ไม่มี fault เปิดอยู่\n");
      break;
    }

    const res = box.enable(faultArg);
    if (!res.ok) {
      console.error(`\n❌ เปิดไม่ได้: ${res.reason}\n`);
      process.exit(1);
    }
    console.log(`\n🧪 เปิด fault "${res.fault}" แล้ว — ${FAULTS[res.fault]}`);
    console.log(`   ดับเองใน ${res.ttlMs / 60000} นาที · ปิดเองได้ด้วย: admin-tool.mjs fault off`);
    console.log("   ⚠️  ระหว่างนี้ลูกค้าจริงจะเจอของพังด้วย — ใช้เฉพาะตอนทดสอบเท่านั้น\n");
    break;
  }

  default:
    console.log(`
เครื่องมือผู้ดูแล — สิทธิ์แอดมินของบอท LINE

  issue          ออกรหัส claim ใหม่ (อายุ ${TTL_MINUTES} นาที ใช้ได้ครั้งเดียว)
                 รหัสเก่าที่ยังไม่ถูกใช้จะถูกยกเลิกทันที
  status         ดูว่ามีแอดมินหรือยัง รายงานไปไหน และมีอะไรค้างคิว
  revoke-admin   ถอนสิทธิ์ · รายงานกลับเป็น deliver=local · ยกเลิกรหัสที่ค้าง
  fault [ชื่อ]   ตัวจำลองความพังสำหรับ Customer Test (ไม่ใส่ชื่อ = ดูสถานะ · off = ปิด)
                 ต้องตั้ง ALLOW_FAULT_INJECTION=1 และต้องยังไม่มีแอดมิน claim

ไม่มีคำสั่งไหนรับรหัสเป็นพารามิเตอร์ และไม่มีคำสั่งขอดูรหัสเดิมซ้ำ
`);
    process.exit(command ? 1 : 0);
}
