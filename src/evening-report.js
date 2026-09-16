/*
 * รายงานเย็น — สรุปวันให้เจ้าของร้านอ่านบนมือถือ
 *
 * ═══ ตัวเลขทุกตัวนับจากไฟล์ ไม่มีตัวไหนถูกแต่งขึ้น ═══
 * ทุกบรรทัดในรายงานนี้นับมาจาก ~/shop-data/customer-events/<วันที่>.jsonl ตรง ๆ
 * วันไหนไม่มีข้อมูลก็บอกว่าไม่มี ไม่เดา ไม่เติมตัวเลขให้ดูมีอะไรเกิดขึ้น
 *
 * รายงานที่มีตัวเลขปลอมแม้แต่ตัวเดียว แย่กว่าไม่มีรายงานเลย เพราะเจ้าของร้านจะเอาไป
 * ตัดสินใจสั่งของ/จ้างคนเพิ่มจากตัวเลขที่ไม่มีอยู่จริง และจะไม่มีวันรู้ว่าตัวไหนจริงตัวไหนปลอม
 *
 * ═══ ลำดับหัวข้อตายตัว ═══
 * เจ้าของร้านอ่านรายงานนี้ทุกวันบนมือถือ ลำดับที่เปลี่ยนไปมาทำให้ต้องอ่านใหม่ทั้งฉบับทุกครั้ง
 * ลำดับจึงตายตัวเสมอ แม้หัวข้อนั้นจะว่าง
 */

import { INTENTS, LEAD_GRADES, bangkokDate, bangkokTime } from "./customer-events.js";

const GRADE_LABEL = { hot: "🔥 hot", warm: "🌤 warm", cold: "❄️ cold" };

/* หัวข้อ "คำถามยอดฮิต" โชว์กี่อันดับ */
const TOP_N = 5;

/* หัวข้อ "คำถามที่ตอบไม่ได้" โชว์กี่ข้อ — เกินนี้บอกจำนวนที่เหลือแทน */
const MAX_UNANSWERED = 5;

/*
 * สรุปตัวเลขจาก event ดิบ — แยกจากตัวประกอบข้อความ เพื่อให้เทสต์ตรวจตัวเลขได้
 * โดยไม่ต้องไปจับคู่กับถ้อยคำในรายงาน (ถ้อยคำเปลี่ยนได้ ตัวเลขห้ามเปลี่ยน)
 */
export function summarize(events) {
  const rooms = new Map(); // suffix -> เกรดสูงสุดที่ห้องนั้นไปถึงวันนี้
  const intents = new Map();
  const handoffs = [];
  const unanswered = [];

  for (const e of events) {
    /* เกรดของห้อง = เกรดที่ "ร้อนที่สุด" ที่ห้องนั้นเคยไปถึงในวันนั้น
     * ลูกค้าที่ทักมาถามราคา (warm) แล้วขอใบเสนอราคา (hot) ต้องนับเป็น hot ไม่ใช่นับสองครั้ง */
    const current = rooms.get(e.suffix);
    const rank = (g) => LEAD_GRADES.indexOf(g);
    if (current === undefined || rank(e.lead) < rank(current)) rooms.set(e.suffix, e.lead);

    intents.set(e.intent, (intents.get(e.intent) ?? 0) + 1);
    if (e.handoff) handoffs.push({ at: e.at, suffix: e.suffix, reason: e.handoff, nextStep: e.next_step });
    if (e.unanswered) unanswered.push({ at: e.at, suffix: e.suffix, question: e.unanswered });
  }

  const byGrade = Object.fromEntries(LEAD_GRADES.map((g) => [g, 0]));
  for (const grade of rooms.values()) byGrade[grade] += 1;

  return {
    total: events.length,
    rooms: rooms.size,
    byGrade,
    topIntents: [...intents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_N),
    handoffs,
    unanswered,
  };
}

/*
 * สิ่งที่เจ้าของต้องทำต่อ — บรรทัดปิดของรายงาน
 * เรียงตามความเร่งด่วน และต้องมีเสมอแม้วันที่ไม่มีอะไรเกิดขึ้น
 * รายงานที่จบลงโดยไม่บอกว่าให้ทำอะไรต่อ คือรายงานที่อ่านแล้วปิดทิ้ง
 */
function nextActions(s) {
  const actions = [];
  if (s.handoffs.length > 0) actions.push(`ตามเคสค้าง ${s.handoffs.length} เคสข้างบนให้จบ`);
  if (s.unanswered.length > 0) actions.push(`เติมคำตอบของ ${s.unanswered.length} คำถามลง context.md / products.md`);
  if (s.byGrade.hot > 0) actions.push(`ปิดการขายลูกค้า hot ${s.byGrade.hot} ราย`);
  if (actions.length === 0) actions.push("ไม่มีอะไรค้าง — เช็กสต็อกและโปรของพรุ่งนี้ได้เลยค่ะ");
  return actions;
}

const clock = (stamp) => String(stamp ?? "").slice(11, 16) || "--:--";

/*
 * ประกอบเป็นข้อความเดียวตาม schema ตายตัว
 * opts.testRun = true จะติดป้ายว่าเป็นการสั่งรันเอง ไม่ใช่รอบของ scheduler
 */
export function renderEveningReport(events, { date, testRun = false, now = () => new Date() } = {}) {
  const day = date ?? bangkokDate(now());
  const s = summarize(events);
  const head = `📊 รายงานเย็น ${day}${testRun ? " · [สั่งรันเอง]" : ""}`;

  /* วันที่ไม่มีข้อมูล — บอกตรง ๆ ว่าไม่มี ห้ามสร้างตัวเลขขึ้นมาเติมช่อง */
  if (events.length === 0) {
    return [head, "", "วันนี้ยังไม่มีบทสนทนาใหม่", "", "📌 สิ่งที่เจ้าของต้องทำต่อ", "  • ไม่มีอะไรค้างค่ะ"].join("\n");
  }

  const lines = [head, ""];

  /* ① ลูกค้าใหม่ */
  lines.push(`👥 ลูกค้าใหม่วันนี้ ${s.rooms} ห้อง (${s.total} เหตุการณ์)`);
  lines.push("");

  /* ② lead แยกเกรด */
  lines.push("📈 Lead แยกเกรด");
  for (const g of LEAD_GRADES) lines.push(`  ${GRADE_LABEL[g]} ${s.byGrade[g]} ราย`);
  lines.push("");

  /* ③ เคสต้องตามด่วน */
  lines.push(`🚨 เคสต้องตามด่วน ${s.handoffs.length} เคส`);
  if (s.handoffs.length === 0) lines.push("  • ไม่มี");
  for (const h of s.handoffs) {
    lines.push(`  • ${clock(h.at)} ห้อง …${h.suffix} — ${h.reason}`);
    if (h.nextStep) lines.push(`      ต้องทำ: ${h.nextStep}`);
  }
  lines.push("");

  /* ④ คำถามยอดฮิต */
  lines.push("💬 คำถามยอดฮิต");
  if (s.topIntents.length === 0) lines.push("  • ไม่มี");
  for (const [intent, count] of s.topIntents) lines.push(`  • ${INTENTS[intent] ?? intent} ${count} ครั้ง`);
  lines.push("");

  /* ⑤ คำถามที่ตอบไม่ได้ */
  lines.push(`❓ คำถามที่ตอบไม่ได้ ${s.unanswered.length} ข้อ`);
  if (s.unanswered.length === 0) lines.push("  • ไม่มี");
  for (const u of s.unanswered.slice(0, MAX_UNANSWERED)) {
    lines.push(`  • ${clock(u.at)} ห้อง …${u.suffix} — "${u.question}"`);
  }
  if (s.unanswered.length > MAX_UNANSWERED) {
    lines.push(`  • (อีก ${s.unanswered.length - MAX_UNANSWERED} ข้อ ดูในไฟล์ของวันนี้)`);
  }
  lines.push("");

  /* ⑥ บรรทัดปิด */
  lines.push("📌 สิ่งที่เจ้าของต้องทำต่อ");
  for (const a of nextActions(s)) lines.push(`  • ${a}`);

  return lines.join("\n");
}

/*
 * รันรายงานเย็น 1 รอบ — scheduler กับคำสั่ง force-run เรียกตัวเดียวกันนี้
 *
 * ที่ต้องเป็น code path เดียวกันเป๊ะ ๆ เพราะถ้าแยกกัน วันหนึ่งจะมีคนแก้ฝั่งหนึ่งแล้วลืมอีกฝั่ง
 * แล้วรายงานที่เจ้าของร้านสั่งทดสอบเองจะหน้าตาไม่เหมือนรายงานที่ส่งจริงทุกเย็น
 * ซึ่งแปลว่าการทดสอบนั้นไม่ได้พิสูจน์อะไรเลย
 */
export async function runEveningReport({ events, reports, date, testRun = false, now = () => new Date() } = {}) {
  const day = date ?? bangkokDate(now());
  const rows = events.readDay(day);
  const text = renderEveningReport(rows, { date: day, testRun, now });
  const deliver = await reports.submit("evening", text);
  return { date: day, count: rows.length, deliver, text, testRun, at: bangkokTime(now()) };
}
