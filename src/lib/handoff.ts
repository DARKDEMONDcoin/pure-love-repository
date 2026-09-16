/**
 * إحالة ذكية بين الموظفين: يحلّل طلب المستخدم (ورد الموظف) ويقرر إن كان الطلب
 * من اختصاص زميل آخر، فيعرض زر «التوجّه إلى …» مع نقل نص الطلب كما هو.
 */

import { employeeDirectory, type EmployeeId } from "@/lib/team-knowledge";

type Rule = { id: EmployeeId; words: string[]; topic: string };

/** كلمات دالة على اختصاص كل موظف — عربية ولاتينية. */
const RULES: Rule[] = [
  {
    id: "sonny",
    topic: "منشورات ونشر السوشيال ميديا",
    words: [
      "منشور", "منشورات", "بوست", "ريلز", "reel", "story", "ستوري", "كاروسيل",
      "هاشتاق", "هاشتاج", "انستجرام", "إنستغرام", "instagram", "تيك توك", "tiktok",
      "سناب", "تويتر", "تغريدة", "فيسبوك", "facebook", "جدولة منشور", "تقويم محتوى", "انشر",
    ],
  },
  {
    id: "nour",
    topic: "المقالات والسيو وصفحات الموقع",
    words: [
      "مقال", "مقالة", "سيو", "seo", "كلمات مفتاحية", "كلمة مفتاحية", "keyword",
      "ترتيب في جوجل", "search console", "ميتا ديسكربشن", "وصف ميتا", "backlink",
      "باك لينك", "صفحة هبوط", "landing page", "مدونة", "ووردبريس", "wordpress", "فهرسة",
    ],
  },
  {
    id: "eva",
    topic: "البريد والمواعيد والتنظيم",
    words: [
      "بريد", "ايميل", "إيميل", "email", "gmail", "inbox", "موعد", "مواعيد",
      "اجتماع", "تقويم", "calendar", "محضر", "تذكير", "رتب يومي", "جدول يومي",
    ],
  },
  {
    id: "sam",
    topic: "المبيعات والعملاء والعروض",
    words: [
      "مبيعات", "عميل محتمل", "عملاء محتملين", "lead", "leads", "صفقة", "صفقات",
      "crm", "hubspot", "عرض سعر", "تسعير عرض", "متابعة عميل", "اعتراض", "pipeline", "خط الأنابيب",
    ],
  },
  {
    id: "dana",
    topic: "التصميم والهوية البصرية",
    words: [
      "تصميم", "هوية بصرية", "لوجو", "شعار", "لوحة ألوان", "خطوط", "canva", "كانفا",
      "figma", "فيجما", "موك اب", "غلاف", "بريف تصميم", "عرض تقديمي",
    ],
  },
  {
    id: "adam",
    topic: "الأرقام والتقارير والحملات",
    words: [
      "تحليل بيانات", "ga4", "analytics", "تقرير أداء", "مؤشرات", "kpi", "conversion",
      "تحويلات", "ميزانية إعلان", "حملة إعلانية", "roas", "cpc", "إنفاق", "لوحة مؤشرات",
    ],
  },
];

export type Handoff = { id: EmployeeId; name: string; role: string; topic: string };

function score(text: string, rule: Rule): number {
  let n = 0;
  for (const w of rule.words) if (text.includes(w)) n += w.length > 5 ? 2 : 1;
  return n;
}

/**
 * يعيد الزميل الأنسب إن كان الطلب واضح الانتماء لاختصاصه وليس اختصاص الموظف الحالي.
 * يعيد null إن كان الطلب ضمن اختصاص الموظف الحالي أو غامضاً.
 */
export function detectHandoff(request: string, currentId: string): Handoff | null {
  const text = (request || "").toLowerCase();
  if (text.trim().length < 4) return null;

  const scores = RULES.map((r) => ({ rule: r, s: score(text, r) })).sort((a, b) => b.s - a.s);
  const top = scores[0];
  if (!top || top.s < 2) return null;
  if (top.rule.id === currentId) return null;

  // إن كان الموظف الحالي قريباً في الدرجة، فالطلب يخصه — لا إحالة.
  const mine = scores.find((x) => x.rule.id === currentId);
  if (mine && mine.s >= top.s) return null;

  const e = employeeDirectory[top.rule.id];
  if (!e) return null;
  return { id: top.rule.id, name: e.name, role: e.role, topic: top.rule.topic };
}
