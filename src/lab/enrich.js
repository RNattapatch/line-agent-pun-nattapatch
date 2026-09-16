/*
 * แปลง event ดิบเป็น 10 ฟิลด์ที่โจทย์ต้องการ
 *
 * ═══ ทำไมเป็นกฎตายตัว ไม่ให้โมเดลสรุป ═══
 * ข้อสรุปพวกนี้ไปจบที่ "ข้อเสนอแก้ Persona" ซึ่งเจ้าของร้านจะเอาไปตัดสินใจจริง
 * ถ้าผลเปลี่ยนทุกครั้งที่รัน เจ้าของร้านจะไม่มีทางรู้ว่าตัวเลขที่เห็นสัปดาห์นี้
 * ต่างจากสัปดาห์ที่แล้วเพราะลูกค้าเปลี่ยน หรือเพราะตัววิเคราะห์เปลี่ยนใจ
 *
 * ผิดได้ แต่ต้องผิดแบบเดิมทุกครั้ง — แล้วเจ้าของร้านจะชี้ได้ว่าให้แก้กฎตรงไหน
 */

/* ช่วงเวลาที่บอกอะไรได้จริงในบริบทร้านขนมปังหน้าโรงเรียน */
export function timeBand(stamp) {
  const hour = Number(String(stamp).slice(11, 13));
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 19) return "after_school";
  return "evening";
}

/* ของชิ้นเล็ก vs ของเป็นกล่อง — ตัวแยกกลุ่มลูกค้าที่ชัดที่สุดในร้านนี้ */
const BULK = new Set(["box-set-1", "brownie-box"]);
const SINGLE = new Set(["brownie-piece", "shio-pan"]);

/*
 * persona_signal — "สัญญาณ" ว่าน่าจะเป็นคนกลุ่มไหน ไม่ใช่คำตัดสิน
 *
 * จงใจตั้งชื่อว่า signal ไม่ใช่ persona เพราะสิ่งที่เรามีคือร่องรอยพฤติกรรม
 * ไม่ใช่ตัวตนของคน — คนคนเดียวกันซื้อของให้ตัวเองตอนเย็นและซื้อเลี้ยงออฟฟิศตอนเที่ยงก็ได้
 */
export function personaSignal(event) {
  const band = timeBand(event.at);
  const triggers = event.triggers ?? [];
  const bulk = BULK.has(event.product);
  const single = SINGLE.has(event.product);

  /* สั่งเป็นเซ็ตตอนพักเที่ยง/ค่ำ + นัดขนส่งหรือขอมารับ = กลิ่นของออฟฟิศชัดที่สุด */
  if ((band === "lunch" || band === "evening") && (bulk || triggers.includes("delivery_appointment"))) {
    return "office";
  }
  if (band === "after_school" && bulk) return "parent_pickup";
  if (band === "after_school" && single) return "student";
  if (triggers.includes("high_value") && bulk) return "bulk_buyer";
  if (band === "morning") return "morning_shopper";
  return "unknown";
}

const PAIN = {
  ask_price: "อยากรู้ว่าราคาอยู่ในงบไหม",
  ask_photo: "อยากเห็นของจริงก่อนตัดสินใจ",
  ask_quote: "ต้องการยอดรวมที่เอาไปเบิก/ตัดสินใจได้",
  confirm_order: "พร้อมซื้อแล้ว ต้องการให้จบไว",
  ask_payment: "อยากรู้ว่าจ่ายยังไง",
  ask_delivery: "ติดเรื่องเวลา/วิธีรับของ",
  complaint: "ได้ของไม่ตรงที่คาด ต้องการให้แก้",
  ask_owner: "เรื่องเกินที่หน้าร้านตัดสินใจได้",
  send_image: "ส่งหลักฐานมาแล้ว รอการยืนยัน",
  greeting: "ยังไม่ระบุ — เพิ่งเริ่มคุย",
  other: "ยังไม่ระบุ",
};

const OBJECTION = {
  over_discount: "ราคาสูงเกินงบ ขอต่อรอง",
  high_value: "ยอดใหญ่ ต้องมีคนอนุมัติก่อน",
  complaint: "ไม่พอใจของที่ได้รับ",
  delivery_appointment: "ติดเรื่องรอบส่ง",
  pickup_request: "มารับเองสะดวกกว่า แต่ต้องนัดเวลา",
  new_appointment: "เวลาที่ร้านให้ยังไม่ลงตัว",
};

/* urgency — ลูกค้าคนนี้รอได้นานแค่ไหนก่อนจะไปร้านอื่น */
function urgencyOf(event) {
  const t = event.triggers ?? [];
  if (t.includes("slip_in") || t.includes("complaint")) return "high";
  if (t.includes("delivery_appointment") || t.includes("pickup_request") || t.includes("new_appointment")) return "high";
  if (event.intent === "confirm_order" || t.includes("high_value")) return "high";
  if (event.lead === "hot") return "medium";
  return "low";
}

/* ขั้นของ lead — ไล่จากเพิ่งทัก ไปจนถึงจ่ายแล้ว */
function leadStage(event) {
  switch (event.intent) {
    case "greeting":
      return "new";
    case "ask_price":
    case "ask_photo":
      return "interested";
    case "ask_quote":
      return (event.triggers ?? []).includes("over_discount") ? "negotiating" : "quoted";
    case "confirm_order":
    case "ask_payment":
      return "ordering";
    case "send_image":
      return "paying";
    default:
      return event.lead === "hot" ? "quoted" : "interested";
  }
}

/*
 * outcome — จบรอบนั้นยังไง
 * "unanswered" สำคัญที่สุด เพราะมันคือคำถามที่ร้านเสียลูกค้าไปโดยไม่รู้ตัว
 */
function outcomeOf(event) {
  if (event.unanswered) return "unanswered";
  if (event.handoff) return "handed_off";
  if (event.intent === "confirm_order" || event.intent === "send_image") return "converted";
  return "answered";
}

/* แปลง 1 event — คืน 10 ฟิลด์ตามที่โจทย์กำหนด บวก id กับเวลาไว้อ้างอิง */
export function enrich(event) {
  const triggers = event.triggers ?? [];
  const objection = triggers.map((t) => OBJECTION[t]).find(Boolean) ?? null;

  return {
    id: event.id,
    at: event.at,
    suffix: event.suffix,
    date: String(event.at).slice(0, 10),
    band: timeBand(event.at),

    intent: event.intent,
    pain_or_need: PAIN[event.intent] ?? PAIN.other,
    product_interest: event.product ?? null,
    objection,
    urgency: urgencyOf(event),
    lead_stage: leadStage(event),
    next_step: event.next_step ?? null,
    outcome: outcomeOf(event),
    unanswered_question: event.unanswered ?? null,
    persona_signal: personaSignal(event),
  };
}

export const enrichAll = (events) => events.map(enrich);

/* 10 ฟิลด์ที่โจทย์สั่ง — เทสต์ใช้ตรวจว่าไม่มีตัวไหนหาย */
export const REQUIRED_FIELDS = [
  "intent", "pain_or_need", "product_interest", "objection", "urgency",
  "lead_stage", "next_step", "outcome", "unanswered_question", "persona_signal",
];
