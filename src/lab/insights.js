/*
 * ตัววิเคราะห์ — daily insight + weekly comparison
 *
 * ═══ เกณฑ์ 3 ถัง ═══
 *   match     สัญญาณตรงกับ Persona ที่เจ้าของร้านตั้งไว้แล้ว
 *   emerging  ไม่ตรง Persona แต่เกิดซ้ำอย่างน้อย 3 เคส
 *   outlier   ไม่ตรง Persona และเป็นเคสเดี่ยว
 *
 * ⚠️ โจทย์นิยาม emerging ที่ "อย่างน้อย 3 เคส" และ outlier ที่ "เคสเดี่ยว"
 * ซึ่งเหลือช่องว่างตรง "2 เคส" ที่ไม่เข้านิยามไหนเลย
 * ตรงนี้จัดเข้าถัง outlier แต่ติดป้ายไว้ว่าอีก 1 เคสจะกลายเป็น emerging
 * เพื่อไม่ให้ของหายไปจากรายงานเงียบ ๆ (ดู NEAR_EMERGING)
 *
 * ═══ evidence count ต้องมาคู่กับทุกข้อสรุปเสมอ ═══
 * ข้อสรุปที่ไม่บอกว่ามาจากกี่เคส คือข้อสรุปที่เถียงไม่ได้และตรวจไม่ได้
 * เจ้าของร้านต้องเห็นตัวเลขก่อนตัดสินใจว่าจะเชื่อแค่ไหน
 */

import { readPersona } from "./persona.js";

/* เกิดซ้ำกี่เคสถึงนับเป็น emerging */
export const EMERGING_MIN = 3;

/* 2 เคส — ยังไม่ถึง emerging แต่ไม่ใช่เคสเดี่ยวแล้ว */
export const NEAR_EMERGING = 2;

/*
 * ค่าที่ไม่ใช่ "กลุ่มลูกค้า" แต่เป็นถังที่จัดไม่ลง
 * ห้ามถูกจัดเป็น emerging เด็ดขาด ไม่งั้นวันหนึ่ง Lab จะเสนอให้เจ้าของร้าน
 * "เพิ่ม Persona กลุ่ม unknown" ซึ่งไม่มีความหมายอะไรเลย
 * นับต่อไปตามปกติเพื่อให้เห็นว่าตัวจัดหมวดพลาดบ่อยแค่ไหน
 */
export const NOT_A_SIGNAL = new Set(["unknown"]);

const dayBefore = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const tally = (rows, key) => {
  const out = new Map();
  for (const r of rows) {
    const value = r[key];
    if (value === null || value === undefined) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(r.id);
  }
  return out;
};

const topOf = (map, n = 5) =>
  [...map.entries()]
    .map(([value, ids]) => ({ value, count: ids.length, source_ids: ids.slice(0, 8) }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
    .slice(0, n);

/*
 * จัดสัญญาณเข้าถัง — คืนอาร์เรย์เรียงจากหนักไปเบา
 * source_ids ติดไปด้วยทุกรายการ เพื่อให้ข้อเสนอที่งอกจากตรงนี้อ้างหลักฐานได้
 */
export function classifySignals(rows, { personaCodes = [] } = {}) {
  const signals = tally(rows, "persona_signal");
  const out = [];

  for (const [signal, ids] of signals) {
    const count = ids.length;
    const isPersona = personaCodes.includes(signal);

    let bucket;
    let note = null;
    if (isPersona) bucket = "match";
    else if (NOT_A_SIGNAL.has(signal)) {
      bucket = "unclassified";
      note = "จัดกลุ่มไม่ได้จากข้อมูลที่มี — ถ้าตัวเลขนี้สูงแปลว่ากฎจัดหมวดต้องปรับ";
    } else if (count >= EMERGING_MIN) bucket = "emerging";
    else {
      bucket = "outlier";
      if (count === NEAR_EMERGING) note = `อีก ${EMERGING_MIN - count} เคสจะเข้าเกณฑ์ emerging`;
    }

    out.push({ signal, bucket, count, note, source_ids: ids.slice(0, 8), total_ids: ids.length });
  }

  const order = { emerging: 0, match: 1, outlier: 2, unclassified: 3 };
  return out.sort((a, b) => order[a.bucket] - order[b.bucket] || b.count - a.count || a.signal.localeCompare(b.signal));
}

/*
 * สรุปของวันเดียว
 * rows ต้องถูก enrich มาแล้ว (ดู src/lab/enrich.js)
 */
export function dailyInsight(rows, { date, persona = readPersona() } = {}) {
  const day = rows.filter((r) => r.date === date);

  return {
    date,
    events: day.length,
    rooms: new Set(day.map((r) => r.suffix)).size,
    signals: classifySignals(day, { personaCodes: persona.codes }),
    pains: topOf(tally(day, "pain_or_need")),
    objections: topOf(tally(day, "objection")),
    products: topOf(tally(day, "product_interest")),
    unanswered: topOf(tally(day, "unanswered_question")),
    stages: topOf(tally(day, "lead_stage"), 8),
    urgencyHigh: day.filter((r) => r.urgency === "high").length,
    outcomes: topOf(tally(day, "outcome"), 8),
  };
}

/*
 * เทียบ 7 วันล่าสุดกับ 7 วันก่อนหน้า
 *
 * ทำไมเทียบสัปดาห์ ไม่เทียบวัน: ร้านหน้าโรงเรียนมีจังหวะรายสัปดาห์ชัดมาก
 * (เสาร์-อาทิตย์เงียบ) เทียบวันต่อวันจะเห็นแต่ "วันหยุด" ไม่เห็นแนวโน้มจริง
 */
export function weeklyComparison(rows, { endDate, persona = readPersona() } = {}) {
  const thisWeek = [];
  const lastWeek = [];
  const thisDays = new Set(Array.from({ length: 7 }, (_, i) => dayBefore(endDate, i)));
  const lastDays = new Set(Array.from({ length: 7 }, (_, i) => dayBefore(endDate, i + 7)));

  for (const r of rows) {
    if (thisDays.has(r.date)) thisWeek.push(r);
    else if (lastDays.has(r.date)) lastWeek.push(r);
  }

  const now = classifySignals(thisWeek, { personaCodes: persona.codes });
  const before = new Map(classifySignals(lastWeek, { personaCodes: persona.codes }).map((s) => [s.signal, s.count]));

  const changes = now.map((s) => {
    const was = before.get(s.signal) ?? 0;
    const delta = s.count - was;
    return {
      ...s,
      was,
      delta,
      /* ฐานเล็กมากแล้วคิดเป็น % จะได้เลขหลอกตา (1 → 3 เคส = +200%) จึงโชว์ % เฉพาะตอนฐานพอ */
      pct: was >= EMERGING_MIN ? Math.round((delta / was) * 100) : null,
    };
  });

  for (const [signal, was] of before) {
    if (!now.some((s) => s.signal === signal)) {
      changes.push({ signal, bucket: "outlier", count: 0, was, delta: -was, pct: null, source_ids: [], note: "หายไปจากสัปดาห์นี้" });
    }
  }

  return {
    window: { from: dayBefore(endDate, 6), to: endDate },
    previous: { from: dayBefore(endDate, 13), to: dayBefore(endDate, 7) },
    thisWeek: thisWeek.length,
    lastWeek: lastWeek.length,
    changes: changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.signal.localeCompare(b.signal)),
    unansweredThisWeek: topOf(tally(thisWeek, "unanswered_question")),
    objectionsThisWeek: topOf(tally(thisWeek, "objection")),
    bandsThisWeek: topOf(tally(thisWeek, "band"), 6),
  };
}
