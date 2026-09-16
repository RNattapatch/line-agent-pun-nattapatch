/*
 * ประกอบรายงาน staging — ข้อความสำหรับอ่านใน terminal และ HTML สำหรับเปิดบนมือถือ
 *
 * ═══ evidence count ต้องอยู่ติดกับทุกข้อสรุป ═══
 * ไม่ใช่รวมไว้ท้ายรายงาน เพราะคนอ่านบนมือถือจะเลื่อนผ่าน
 * ตัวเลขต้องอยู่ตรงที่ตาตกพอดีกับข้อสรุปนั้น ไม่งั้นข้อสรุปจะถูกอ่านเหมือนเป็นข้อเท็จจริง
 *
 * ═══ ไม่มีปุ่มที่กดแล้วเกิดอะไรขึ้นจริง ═══
 * หน้า HTML นี้เป็นของอ่านอย่างเดียว การตัดสินใจทำผ่าน CLI ที่ staging
 * ปุ่มบนหน้าเว็บที่กดแล้วแก้ Persona ได้เลยคือสิ่งที่โจทย์ห้ามไว้ตรง ๆ
 * ที่นี่จึงมีแค่ "คำสั่งที่ต้องไปพิมพ์" ให้คัดลอกไปรัน
 */

import { DECISIONS } from "./ledger.js";

const BUCKET_TH = {
  match: { label: "ตรง Persona", icon: "✅" },
  emerging: { label: "กลุ่มที่กำลังโต", icon: "📈" },
  outlier: { label: "เคสเดี่ยว", icon: "•" },
  unclassified: { label: "จัดกลุ่มไม่ได้", icon: "❓" },
};

const TYPE_TH = {
  persona: "แก้ Persona",
  faq: "เพิ่ม FAQ",
  script: "ปรับสคริปต์",
  marketing_brief: "Marketing Brief",
};

const STATUS_TH = {
  pending: "รอเจ้าของร้านตัดสิน",
  approved: "Approve แล้ว — รอคนไปแก้เอง",
  rejected: "Reject แล้ว",
  observing: "รอดูอีก 1 สัปดาห์",
};

const arrow = (d) => (d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "— 0");

/* ───────── ข้อความ ───────── */

export function renderText({ daily, weekly, proposals, persona, ledger = null, meta = {} }) {
  const L = [];
  L.push(`🧪 Customer Intelligence — staging report`);
  L.push(`   ช่วงวิเคราะห์ ${meta.from ?? "-"} → ${meta.to ?? "-"} (${meta.days ?? "-"} วัน · ${meta.events ?? 0} เหตุการณ์)`);
  L.push(`   แหล่งข้อมูล: ${meta.source ?? "demo"} · Persona ปัจจุบัน: ${persona.codes.join(" · ") || "-"}`);
  L.push("");

  L.push(`📅 รายวัน ${daily.date} — ${daily.events} เหตุการณ์ · ${daily.rooms} ห้อง · เร่งด่วน ${daily.urgencyHigh}`);
  for (const s of daily.signals) {
    const b = BUCKET_TH[s.bucket];
    L.push(`   ${b.icon} ${b.label.padEnd(16)} ${s.signal.padEnd(16)} ${s.count} เคส${s.note ? ` · ${s.note}` : ""}`);
  }
  L.push("");

  L.push(`📊 เทียบสัปดาห์  ${weekly.window.from}→${weekly.window.to} (${weekly.thisWeek}) vs ${weekly.previous.from}→${weekly.previous.to} (${weekly.lastWeek})`);
  for (const c of weekly.changes) {
    const b = BUCKET_TH[c.bucket];
    const pct = c.pct !== null ? ` (${c.pct > 0 ? "+" : ""}${c.pct}%)` : "";
    L.push(`   ${b.icon} ${c.signal.padEnd(16)} ${String(c.count).padStart(3)} เคส  เดิม ${String(c.was).padStart(3)}  ${arrow(c.delta)}${pct}`);
  }
  L.push("");

  if (weekly.unansweredThisWeek.length) {
    L.push("❓ คำถามที่ตอบไม่ได้ (สัปดาห์นี้)");
    for (const q of weekly.unansweredThisWeek) L.push(`   • "${q.value}" — ${q.count} ครั้ง`);
    L.push("");
  }

  L.push(`💡 ข้อเสนอ ${proposals.length} ใบ — ทุกใบรอ Approve ก่อนถึงจะมีใครไปแก้ของจริง`);
  for (const p of proposals) {
    const status = ledger?.statusOf(p.id) ?? p.status;
    L.push("");
    L.push(`   [${p.id}] ${TYPE_TH[p.type] ?? p.type} · สถานะ: ${STATUS_TH[status] ?? status}`);
    L.push(`   ${p.title}`);
    for (const line of p.body.split("\n")) L.push(`     ${line}`);
    L.push(`     หลักฐาน: ${p.evidence.count} เคส · ids: ${p.evidence.source_ids.join(", ")}`);
    L.push(`     ผลที่คาด: ${p.expected_impact}`);
    L.push(`     ถอยกลับ: ${p.rollback.method}`);
  }

  L.push("");
  L.push("🖐  ตัดสินใจ (รันที่ staging เท่านั้น):");
  for (const d of Object.values(DECISIONS)) {
    L.push(`   npm run lab -- decide <proposal-id> ${d.id}   # ${d.effect}`);
  }
  return L.join("\n");
}

/* ───────── HTML สำหรับมือถือ ───────── */

/*
 * หน้านี้เป็น "เครื่องมือที่ถูกกวาดสายตา" ไม่ใช่บทความที่อ่านจากบนลงล่าง
 * สิ่งที่ต้องอ่านออกภายในวินาทีแรกคือ "มีอะไรต้องตัดสินใจกี่เรื่อง" — จึงขึ้นด้วยแถบสรุป
 * ส่วนสถานะของแต่ละอย่างเข้ารหัสด้วย "รูปทรง" (แถบสี + ชิป) ไม่ใช่แค่ตัวเลข
 * เจ้าของร้านจะได้กวาดตาเห็นก่อนว่าอันไหนต้องสนใจ แล้วค่อยอ่านตัวเลข
 *
 * สีน้ำตาลที่ใช้เป็นสีเดียวกับการ์ดสินค้าใน cards/templates/ — ของที่มีอยู่แล้วในร้าน
 * ไม่ได้ตั้งสีใหม่ให้หน้านี้โดยเฉพาะ
 */

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STYLE = `
:root{
  --paper:#FBF9F6; --surface:#FFFFFF; --ink:#241E19; --muted:#7C7068; --line:#E8E0D7;
  --accent:#8C6A3F; --accent-soft:#F1E7DA;
  --match:#2F7D5B; --emerging:#C2610C; --outlier:#8A8078; --unclassified:#A9A29B;
  --bar-now:#8C6A3F; --bar-was:#DBD0C2;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#15110E; --surface:#1E1813; --ink:#EFE7DD; --muted:#A0948A; --line:#2E2620;
    --accent:#CFA771; --accent-soft:#2A211A;
    --match:#5FB98C; --emerging:#E09A4E; --outlier:#8F857C; --unclassified:#6F665F;
    --bar-now:#CFA771; --bar-was:#3A312A;
  }
}
:root[data-theme="dark"]{
  --paper:#15110E; --surface:#1E1813; --ink:#EFE7DD; --muted:#A0948A; --line:#2E2620;
  --accent:#CFA771; --accent-soft:#2A211A;
  --match:#5FB98C; --emerging:#E09A4E; --outlier:#8F857C; --unclassified:#6F665F;
  --bar-now:#CFA771; --bar-was:#3A312A;
}

*{box-sizing:border-box}
body{
  background:var(--paper); color:var(--ink);
  font-family:"Sarabun","Noto Sans Thai",-apple-system,system-ui,sans-serif;
  font-size:15px; line-height:1.65; margin:0; padding:20px 16px 48px;
}
.wrap{max-width:720px;margin-inline:auto;display:flex;flex-direction:column;gap:30px}
h1,h2,h3,.eyebrow,.n{font-family:"IBM Plex Sans Thai","Sarabun",system-ui,sans-serif}
.n,code,.id{font-variant-numeric:tabular-nums}

header h1{font-size:23px;font-weight:600;margin:0;letter-spacing:-.01em;text-wrap:balance}
header p{margin:4px 0 0;color:var(--muted);font-size:13px}

.eyebrow{
  font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);margin:0 0 10px
}

/* แถบสรุป — ตัวเลขที่ต้องเห็นก่อนอย่างอื่น */
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.summary div{background:var(--surface);padding:12px 14px}
.summary .n{display:block;font-size:24px;font-weight:600;line-height:1.2}
.summary small{color:var(--muted);font-size:12px}
.summary .hot .n{color:var(--emerging)}

.gate{
  background:var(--accent-soft);border-radius:10px;padding:12px 14px;
  font-size:13px;line-height:1.55;color:var(--ink)
}
.gate b{font-weight:600}

/* แถวสัญญาณ — แถบสีซ้ายบอกถังทันทีโดยไม่ต้องอ่าน */
.signals{display:flex;flex-direction:column;gap:2px}
.sig{
  display:grid;grid-template-columns:4px 1fr auto;column-gap:12px;row-gap:3px;align-items:baseline;
  background:var(--surface);border:1px solid var(--line);border-left:0;border-radius:0 8px 8px 0;
  padding:11px 14px 11px 0;overflow:hidden
}
.sig::before{content:"";grid-row:1/-1;align-self:stretch;background:var(--outlier);margin-right:11px}
.sig.match::before{background:var(--match)}
.sig.emerging::before{background:var(--emerging)}
.sig.unclassified::before{background:var(--unclassified)}
.sig .name{font-weight:600}
.sig .n{font-size:15px;white-space:nowrap}
.sig .meta{grid-column:2/-1;font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 10px}
.sig .note{grid-column:2/-1;font-size:12px;color:var(--emerging)}
.tag{font-size:11px;font-weight:600;letter-spacing:.04em}
.match .tag{color:var(--match)} .emerging .tag{color:var(--emerging)}
.outlier .tag{color:var(--outlier)} .unclassified .tag{color:var(--unclassified)}

/*
 * แท่งเทียบสัปดาห์ — สัปดาห์นี้อยู่บน สัปดาห์ก่อนอยู่ล่าง เห็นทิศทางโดยไม่ต้องคิดเลข
 * flex-basis:100% บังคับให้ตกลงบรรทัดใหม่ของ .meta (ซึ่งเป็น flex-wrap)
 * ไม่งั้นแท่งจะถูกบีบจนเหลือเส้นเดียวจนมองไม่เห็น
 */
.bars{flex:0 0 100%;display:flex;flex-direction:column;gap:3px;margin-top:6px;max-width:320px}
.bar{height:6px;border-radius:3px;background:var(--bar-was);position:relative;min-width:2px}
.bar.now{background:var(--bar-now)}
.delta.up{color:var(--emerging)} .delta.down{color:var(--muted)}

ul.qs{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
ul.qs li{display:flex;justify-content:space-between;gap:12px;align-items:baseline;
  border-bottom:1px solid var(--line);padding-bottom:8px}
ul.qs .n{color:var(--muted);font-size:13px;white-space:nowrap}

.cards{display:flex;flex-direction:column;gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
.card > header{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}
.kind{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.chip{font-size:11px;font-weight:600;border:1px solid var(--line);border-radius:99px;
  padding:3px 10px;color:var(--muted);white-space:nowrap}
.chip.approved{color:var(--match);border-color:var(--match)}
.chip.rejected{color:var(--outlier)}
.chip.observing{color:var(--emerging);border-color:var(--emerging)}
.card h3{font-size:16px;font-weight:600;margin:0 0 6px;text-wrap:balance}
.card .say{color:var(--muted);font-size:14px;margin:0 0 12px}
dl{margin:0;display:grid;grid-template-columns:minmax(66px,auto) 1fr;gap:6px 12px;font-size:13px;
  border-top:1px solid var(--line);padding-top:12px}
dt{color:var(--muted);font-weight:600;font-size:12px}
dd{margin:0;overflow-wrap:anywhere}
code,.id{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px}
code{background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:2px 6px;
  display:block;overflow-x:auto;white-space:pre-wrap}
.card .run{margin-top:12px}
.card .run .eyebrow{margin-bottom:6px}

footer{border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:12px;line-height:1.7}
`;

const BUCKET_TAG = { match: "ตรง PERSONA", emerging: "กำลังโต", outlier: "เคสเดี่ยว", unclassified: "จัดกลุ่มไม่ได้" };

export function renderHtml({ daily, weekly, proposals, persona, ledger = null, meta = {} }) {
  const statusOf = (p) => ledger?.statusOf(p.id) ?? p.status;
  const pending = proposals.filter((p) => statusOf(p) === "pending").length;
  const emerging = weekly.changes.filter((c) => c.bucket === "emerging").length;

  const sigRow = (s, extra = "") => `
      <div class="sig ${esc(s.bucket)}">
        <span class="name">${esc(s.signal)}</span>
        <span class="n">${s.count}<span style="color:var(--muted);font-size:12px"> เคส</span></span>
        <div class="meta"><span class="tag">${esc(BUCKET_TAG[s.bucket])}</span>${extra}</div>
        ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}
      </div>`;

  /* แท่งเทียบ — ความยาวอิงเคสมากสุดของสัปดาห์ เพื่อให้ทุกแถวอ่านบนมาตราเดียวกัน */
  const peak = Math.max(1, ...weekly.changes.flatMap((c) => [c.count, c.was]));
  const cmpRow = (c) => {
    const d = c.delta;
    const dir = d > 0 ? "up" : "down";
    const pct = c.pct !== null ? ` · ${c.pct > 0 ? "+" : ""}${c.pct}%` : "";
    return sigRow(
      c,
      `<span>สัปดาห์ก่อน ${c.was}</span><span class="delta ${dir}">${d > 0 ? "▲ +" : d < 0 ? "▼ " : "— "}${d === 0 ? 0 : Math.abs(d) * (d < 0 ? -1 : 1)}${pct}</span>
         <div class="bars">
           <div class="bar now" style="width:${Math.round((c.count / peak) * 100)}%"></div>
           <div class="bar" style="width:${Math.round((c.was / peak) * 100)}%"></div>
         </div>`,
    );
  };

  const card = (p) => {
    const st = statusOf(p);
    return `
      <article class="card">
        <header>
          <span class="kind">${esc(TYPE_TH[p.type] ?? p.type)}</span>
          <span class="chip ${esc(st)}">${esc(STATUS_TH[st] ?? st)}</span>
        </header>
        <h3>${esc(p.title)}</h3>
        <p class="say">${esc(p.body).replace(/\n/g, "<br>")}</p>
        <dl>
          <dt>หลักฐาน</dt><dd><b class="n">${p.evidence.count}</b> เคส · <span class="id">${esc(p.evidence.source_ids.join(" "))}</span></dd>
          <dt>ผลที่คาด</dt><dd>${esc(p.expected_impact)}</dd>
          <dt>ถอยกลับ</dt><dd>${esc(p.rollback.method)}</dd>
        </dl>
        <div class="run">
          <p class="eyebrow">ตัดสินใจที่ staging</p>
          <code>npm run lab -- decide ${esc(p.id)} approve|reject|observe</code>
        </div>
      </article>`;
  };

  return `<title>ห้องแล็บสัญญาณลูกค้า</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&family=IBM+Plex+Sans+Thai:wght@500;600&family=Sarabun:wght@400;600&display=swap">
<style>${STYLE}</style>
<div class="wrap">
  <header>
    <h1>ห้องแล็บสัญญาณลูกค้า</h1>
    <p>staging · ${esc(meta.from)} → ${esc(meta.to)} · ${esc(meta.days)} วัน · แหล่งข้อมูล ${esc(meta.source)}</p>
  </header>

  <section class="summary">
    <div><span class="n">${meta.events ?? 0}</span><small>เหตุการณ์ ${esc(meta.days)} วัน</small></div>
    <div><span class="n">${weekly.thisWeek}</span><small>สัปดาห์นี้</small></div>
    <div class="${emerging ? "hot" : ""}"><span class="n">${emerging}</span><small>กลุ่มกำลังโต</small></div>
    <div class="${pending ? "hot" : ""}"><span class="n">${pending}</span><small>รอตัดสินใจ</small></div>
  </section>

  <div class="gate">
    ข้อมูลทั้งหมดเป็น <b>demo event แบบ pseudonymous</b> — ผ่าน privacy scan แล้ว ${esc(meta.scan ?? "")}
    ไม่มีชื่อ เบอร์โทร หรือบทสนทนาดิบของลูกค้าคนไหนอยู่ในหน้านี้<br>
    ทุกข้อเสนอ <b>รอ Approve</b> — ยังไม่มีไฟล์ของร้านไฟล์ไหนถูกแก้ และหน้านี้กดแก้อะไรไม่ได้
  </div>

  <section>
    <p class="eyebrow">รายวัน · ${esc(daily.date)} · ${daily.events} เหตุการณ์ · ${daily.rooms} ห้อง · เร่งด่วน ${daily.urgencyHigh}</p>
    <div class="signals">${daily.signals.map((s) => sigRow(s)).join("")}</div>
  </section>

  <section>
    <p class="eyebrow">เทียบสัปดาห์ · ${esc(weekly.window.from)}–${esc(weekly.window.to)} เทียบ ${esc(weekly.previous.from)}–${esc(weekly.previous.to)}</p>
    <div class="signals">${weekly.changes.map(cmpRow).join("")}</div>
  </section>

  ${
    weekly.unansweredThisWeek.length
      ? `<section>
    <p class="eyebrow">คำถามที่ตอบไม่ได้ สัปดาห์นี้</p>
    <ul class="qs">${weekly.unansweredThisWeek.map((q) => `<li><span>${esc(q.value)}</span><span class="n">${q.count} ครั้ง</span></li>`).join("")}</ul>
  </section>`
      : ""
  }

  <section>
    <p class="eyebrow">ข้อเสนอ ${proposals.length} ใบ · รอ Approve ${pending} ใบ</p>
    <div class="cards">${proposals.map(card).join("")}</div>
  </section>

  <footer>
    Persona ปัจจุบัน: ${esc(persona.codes.join(" · ") || "-")} — แก้ได้ด้วยมือเจ้าของร้านเท่านั้น<br>
    เกณฑ์: ตรง Persona = อยู่ในรายการข้างบนแล้ว · กำลังโต = เกิดซ้ำตั้งแต่ 3 เคส · เคสเดี่ยว = 1-2 เคส
  </footer>
</div>`;
}
