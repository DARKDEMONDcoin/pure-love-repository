/**
 * مقياس جودة المنشور قبل النشر (يعمل على المتصفح والخادم).
 *
 * الهدف: لا يخرج أي منشور من «سهل» بجودة أقل من معايير أفضل أدوات السوشيال العالمية.
 * كل بند هنا قاعدة قابلة للقياس (لا رأي): الهوك، الطول المناسب للمنصة، دعوة الفعل،
 * الهاشتاقات، القابلية للقراءة، الرموز التعبيرية، الكلمات الممنوعة، والحشو التسويقي.
 */

import { PROVIDER_LABEL } from "./platforms";

export type QualitySeverity = "pass" | "warn" | "fail";

export type QualityCheck = {
  id: string;
  label: string;
  severity: QualitySeverity;
  /** ما الذي يجب فعله لرفع الدرجة — بصيغة أمر مباشر. */
  hint: string;
  weight: number;
};

export type QualityReport = {
  score: number; // 0..100
  grade: "ممتاز" | "جيد" | "يحتاج تحسين" | "ضعيف";
  provider: string;
  providerLabel: string;
  chars: number;
  words: number;
  hashtags: string[];
  emojis: number;
  checks: QualityCheck[];
  blockers: QualityCheck[];
};

/** حدود ومعايير كل منصة — مبنية على أطوال المنصات الرسمية وأفضل الممارسات المنشورة. */
type Spec = {
  hardLimit: number;
  /** المدى الذي يحقق أعلى تفاعل عادةً. */
  sweet: [number, number];
  hashtags: [number, number];
  maxEmojis: number;
  needsMedia: boolean;
  maxLineLen: number;
};

const SPEC: Record<string, Spec> = {
  instagram: { hardLimit: 2200, sweet: [120, 700], hashtags: [3, 10], maxEmojis: 8, needsMedia: true, maxLineLen: 160 },
  facebook: { hardLimit: 5000, sweet: [80, 600], hashtags: [0, 4], maxEmojis: 6, needsMedia: false, maxLineLen: 200 },
  linkedin: { hardLimit: 3000, sweet: [400, 1600], hashtags: [3, 5], maxEmojis: 3, needsMedia: false, maxLineLen: 220 },
  x: { hardLimit: 280, sweet: [70, 260], hashtags: [0, 2], maxEmojis: 3, needsMedia: false, maxLineLen: 280 },
  pinterest: { hardLimit: 480, sweet: [80, 400], hashtags: [0, 5], maxEmojis: 3, needsMedia: true, maxLineLen: 200 },
  youtube: { hardLimit: 5000, sweet: [100, 1200], hashtags: [0, 3], maxEmojis: 5, needsMedia: false, maxLineLen: 220 },
};

const DEFAULT_SPEC: Spec = {
  hardLimit: 3000,
  sweet: [80, 900],
  hashtags: [0, 6],
  maxEmojis: 6,
  needsMedia: false,
  maxLineLen: 200,
};

/** دعوات الفعل الشائعة بالعربية والإنجليزية. */
const CTA = /(اطلب|احجز|سجّل|سجل|اشترك|جرّب|جرب|تواصل|كلّمنا|كلمنا|راسلنا|زور|زر\s|حمّل|حمل\s|اضغط|شاركنا|علّق|علق\s|احفظ|تابعنا|استفد|اغتنم|رابط\s+ال|بالبايو|في\s+البايو|dm|link\s+in\s+bio|order|book|sign\s*up|subscribe)/iu;

/** أنماط هوك قوي في أول سطر: سؤال، رقم، مفاجأة، أو خطاب مباشر. */
const HOOK_QUESTION = /[؟?]/u;
const HOOK_NUMBER = /(\d|[٠-٩]|نصف|ضعف|أول|آخر)/u;
const HOOK_DIRECT = /(أنت|إنت|لو\s|إذا\s|تخيل|تخيّل|توقف|بلاش|لا\s+ت|كفاية|سر\s|٣|3\s+أسباب|هل\s)/u;

/** حشو تسويقي مستهلك يخفض المصداقية — وأشهر بصمات النص المولّد آلياً. */
const FLUFF = [
  "الأفضل في العالم",
  "الأفضل على الإطلاق",
  "بدون منازع",
  "لا مثيل له",
  "حصري جداً",
  "فرصة العمر",
  "مجاناً 100%",
  "مجانا 100%",
  "ثورة حقيقية",
  "الحل السحري",
  "في عالم اليوم",
  "في عالم اليوم سريع التغير",
  "في عصرنا الحالي",
  "مما لا شك فيه",
  "انطلاقاً من",
  "نقدّم لكم بكل فخر",
  "نقدم لكم بكل فخر",
  "يسعدنا أن نعلن",
  "تجربة لا تُنسى",
  "تجربة لا تنسى",
  "نقلة نوعية",
  "الحل الأمثل",
  "لكل احتياجاتكم",
  "منتجاتنا الرائعة",
  "جودة عالية بأسعار تنافسية",
  "في المكان الصحيح",
];

/** تفصيلة ملموسة تجعل المنشور مصدقاً: رقم، سعر، وقت، مكان، أو مدة. */
const CONCRETE =
  /(\d|[٠-٩]|ريال|جنيه|درهم|دينار|دقيقة|دقايق|ساعة|ساعات|يوم|أسبوع|شهر|صباح|مساء|حي\s|شارع|فرع|جرام|سعرة|كيلو|%|٪)/u;

/** بقايا تقنية لا يجوز أن تصل للمنصة إطلاقاً. */
const ARTIFACTS = [
  /```/,
  /\{\s*"(?:reply|body|title|kind|channel|deliverables?)"/i,
  /!\[[^\]]*\]\(/,
  /\bimage_prompt\b/i,
  /https?:\/\/\S*\/storage\/v1\//i,
  /^\s*#{1,6}\s+\S/m,
  /\*\*[^*]+\*\*/,
  /^\s*\|.+\|\s*$/m,
];

const EMOJI = /\p{Extended_Pictographic}/gu;

export function countEmojis(text: string): number {
  return (text.match(EMOJI) ?? []).length;
}

export function extractHashtags(text: string): string[] {
  return [...new Set(text.match(/#[\p{L}\p{N}_]+/gu) ?? [])];
}

function bodyWithoutTags(text: string): string {
  return text.replace(/#[\p{L}\p{N}_]+/gu, " ").replace(/\s+/g, " ").trim();
}

type Input = {
  text: string;
  provider: string;
  hasMedia?: boolean;
  bannedWords?: string[];
};

/**
 * يفحص المنشور ويعيد درجة من ١٠٠ مع أسباب واضحة وإرشاد للإصلاح.
 * الدرجة = مجموع أوزان البنود الناجحة (نصف الوزن للتحذير) من إجمالي الأوزان.
 */
export function scorePost({ text, provider, hasMedia = false, bannedWords = [] }: Input): QualityReport {
  const spec = SPEC[provider] ?? DEFAULT_SPEC;
  const clean = text.trim();
  const core = bodyWithoutTags(clean);
  const chars = clean.length;
  const words = core ? core.split(/\s+/).length : 0;
  const hashtags = extractHashtags(clean);
  const emojis = countEmojis(clean);
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";

  const checks: QualityCheck[] = [];
  const add = (
    id: string,
    label: string,
    weight: number,
    severity: QualitySeverity,
    hint: string,
  ) => checks.push({ id, label, weight, severity, hint });

  // ١) بقايا تقنية — حاجز نشر.
  const artifact = ARTIFACTS.some((re) => re.test(clean));
  add(
    "artifacts",
    "نص نظيف بلا رموز تنسيق أو أكواد",
    18,
    artifact ? "fail" : "pass",
    artifact
      ? "النص يحتوي تنسيق Markdown أو بقايا تقنية (**، ###، جدول، كود، رابط صورة) — احذفها قبل النشر."
      : "النص خالٍ من أي تنسيق تقني.",
  );

  // ٢) الكلمات الممنوعة — حاجز نشر.
  const hitBanned = bannedWords
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && clean.includes(w));
  add(
    "banned",
    "الالتزام بكلمات العلامة الممنوعة",
    14,
    hitBanned.length ? "fail" : "pass",
    hitBanned.length ? `احذف: ${hitBanned.join("، ")}` : "لا توجد كلمة ممنوعة.",
  );

  // ٣) حد المنصة — حاجز نشر.
  const overLimit = chars > spec.hardLimit;
  add(
    "limit",
    `الطول ضمن حد ${PROVIDER_LABEL[provider] ?? provider}`,
    12,
    overLimit ? "fail" : "pass",
    overLimit
      ? `النص ${chars} حرفاً والحد ${spec.hardLimit} — اختصره وإلا سيُقتطع.`
      : `${chars} حرفاً من ${spec.hardLimit}.`,
  );

  // ٤) الطول المثالي للتفاعل.
  const [lo, hi] = spec.sweet;
  const lengthOk = chars >= lo && chars <= hi;
  add(
    "sweet",
    "الطول في المدى الأعلى تفاعلاً",
    10,
    lengthOk ? "pass" : "warn",
    lengthOk
      ? `مناسب (${lo}–${hi} حرفاً).`
      : chars < lo
        ? `قصير جداً — المدى الأفضل ${lo}–${hi} حرفاً؛ أضف فائدة أو تفصيلة ملموسة.`
        : `أطول من المدى الأفضل ${lo}–${hi} حرفاً؛ احذف الحشو.`,
  );

  // ٥) الهوك في أول سطر.
  const hookLen = firstLine.length;
  const strongHook =
    hookLen > 0 &&
    hookLen <= 90 &&
    (HOOK_QUESTION.test(firstLine) || HOOK_NUMBER.test(firstLine) || HOOK_DIRECT.test(firstLine));
  add(
    "hook",
    "هوك قوي في أول سطر",
    14,
    strongHook ? "pass" : hookLen ? "warn" : "fail",
    strongHook
      ? "أول سطر يوقف التمرير."
      : "اجعل أول سطر قصيراً (أقل من ٩٠ حرفاً) وفيه سؤال أو رقم أو خطاب مباشر للقارئ.",
  );

  // ٦) دعوة فعل واضحة.
  const hasCta = CTA.test(clean);
  add(
    "cta",
    "دعوة فعل واضحة",
    12,
    hasCta ? "pass" : "warn",
    hasCta ? "يوجد إجراء مطلوب من القارئ." : "أضف سطر دعوة فعل: احجز، اطلب، علّق، أو الرابط في البايو.",
  );

  // ٧) الهاشتاقات حسب المنصة.
  const [htLo, htHi] = spec.hashtags;
  const htOk = hashtags.length >= htLo && hashtags.length <= htHi;
  add(
    "hashtags",
    "عدد هاشتاقات مناسب للمنصة",
    8,
    htOk ? "pass" : "warn",
    htOk
      ? `${hashtags.length} هاشتاق.`
      : hashtags.length < htLo
        ? `أضف هاشتاقات (${htLo}–${htHi}) مرتبطة بالمجال والسوق.`
        : `قلّل الهاشتاقات إلى ${htHi} كحد أقصى على هذه المنصة.`,
  );

  // ٨) الرموز التعبيرية.
  const emojiOk = emojis <= spec.maxEmojis;
  add(
    "emoji",
    "رموز تعبيرية بلا مبالغة",
    5,
    emojiOk ? "pass" : "warn",
    emojiOk ? `${emojis} رمزاً.` : `قلّلها إلى ${spec.maxEmojis} كحد أقصى.`,
  );

  // ٩) قابلية القراءة: أسطر قصيرة وفقرات مفصولة.
  const longLine = lines.find((l) => l.length > spec.maxLineLen);
  const readable = !longLine && (chars < 220 || clean.includes("\n"));
  add(
    "readable",
    "سهولة القراءة على الجوال",
    9,
    readable ? "pass" : "warn",
    readable
      ? "الأسطر قصيرة والفقرات مفصولة."
      : "اكسر النص إلى فقرات قصيرة (سطر أو سطران) ليسهل قراءته على الجوال.",
  );

  // ١٠) الحشو التسويقي وبصمة النص الآلي — بندان يفصلان المنشور الاحترافي عن القالب.
  const fluff = FLUFF.filter((f) => clean.includes(f));
  add(
    "fluff",
    "بلا مبالغة أو حشو تسويقي",
    16,
    fluff.length >= 2 ? "fail" : fluff.length === 1 ? "warn" : "pass",
    fluff.length ? `استبدل بعبارات ملموسة: ${fluff.join("، ")}` : "الصياغة ملموسة.",
  );

  // ١٠ب) تفصيلة ملموسة (رقم/سعر/وقت/مكان) — بدونها المنشور كلام عام لا يبيع.
  const concrete = CONCRETE.test(core);
  add(
    "concrete",
    "تفصيلة ملموسة (رقم أو وقت أو مكان)",
    10,
    concrete ? "pass" : "warn",
    concrete ? "يوجد تفصيل محدد." : "أضف تفصيلة محددة: رقم، سعر، مدة، أو اسم مكان — العموميات لا تُقنع.",
  );

  // ١١) الوسائط عندما تشترطها المنصة.
  if (spec.needsMedia) {
    add(
      "media",
      "صورة أو فيديو مرفق",
      10,
      hasMedia ? "pass" : "fail",
      hasMedia ? "الوسائط جاهزة." : `${PROVIDER_LABEL[provider] ?? provider} لا ينشر بدون صورة أو فيديو.`,
    );
  }

  // ١٢) تكرار داخلي.
  const sentences = core.split(/[.!؟\n]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 20);
  const repeated = sentences.length !== new Set(sentences).size;
  add(
    "repeat",
    "بلا جمل مكرّرة",
    6,
    repeated ? "warn" : "pass",
    repeated ? "توجد جملة مكررة — احذف النسخة الزائدة." : "لا تكرار.",
  );

  const total = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce(
    (s, c) => s + (c.severity === "pass" ? c.weight : c.severity === "warn" ? c.weight * 0.5 : 0),
    0,
  );
  const score = Math.round((earned / total) * 100);

  return {
    score,
    grade: score >= 90 ? "ممتاز" : score >= 75 ? "جيد" : score >= 55 ? "يحتاج تحسين" : "ضعيف",
    provider,
    providerLabel: PROVIDER_LABEL[provider] ?? provider,
    chars,
    words,
    hashtags,
    emojis,
    checks,
    blockers: checks.filter((c) => c.severity === "fail"),
  };
}

/** يفحص كل المنصات المختارة ويعيد أضعف تقرير (الذي يجب إصلاحه أولاً). */
export function scoreForProviders(
  providers: string[],
  input: Omit<Input, "provider">,
): QualityReport[] {
  return providers.map((provider) => scorePost({ ...input, provider })).sort((a, b) => a.score - b.score);
}
