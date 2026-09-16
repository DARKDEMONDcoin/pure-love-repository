/**
 * «رفع جودة المنشور» — إعادة كتابة حتمية الهدف: نأخذ نص المنشور الحالي،
 * نقيسه بمقياس الجودة (post-quality)، ونعطي النموذج قائمة الإصلاحات المطلوبة
 * بالضبط، ثم نعيد القياس ونحتفظ بالأفضل. لا شيء تجميلي: إن لم ترتفع الدرجة
 * نُبقي النص الأصلي.
 */
import { freeChat } from "./nour-research.server";
import { sanitizePostBody } from "./post-format";
import { scorePost, type QualityReport } from "./post-quality";
import { PROVIDER_LABEL } from "./platforms";

export type ImproveInput = {
  text: string;
  provider: string;
  hasMedia?: boolean | undefined;
  bannedWords?: string[] | undefined;
  tone?: string | undefined;
  industry?: string | undefined;
  city?: string | undefined;
  /** عدد النسخ البديلة المطلوبة (١–٣). */
  variants?: number | undefined;
};

export type ImproveVariant = {
  text: string;
  score: number;
  grade: QualityReport["grade"];
  angle: string;
};

export type ImproveResult = {
  before: { score: number; grade: QualityReport["grade"] };
  variants: ImproveVariant[];
  fixed: string[];
};

const ANGLES = [
  "زاوية «الهوك بسؤال/رقم صادم» ثم فائدة ملموسة",
  "زاوية «قصة قصيرة من الواقع» بضمير المتكلم",
  "زاوية «قائمة نقاط سريعة» سهلة القراءة على الجوال",
];

function rulesFor(report: QualityReport, input: ImproveInput): string {
  const musts = report.checks
    .filter((c) => c.severity !== "pass")
    .map((c) => `- ${c.label}: ${c.hint}`);
  return [
    `المنصة: ${PROVIDER_LABEL[input.provider] ?? input.provider}`,
    input.tone ? `نبرة العلامة: ${input.tone}` : "",
    input.industry ? `المجال: ${input.industry}` : "",
    input.city ? `السوق/المدينة: ${input.city}` : "",
    input.bannedWords?.length ? `كلمات ممنوعة تماماً: ${input.bannedWords.join("، ")}` : "",
    musts.length ? `إصلاحات إلزامية:\n${musts.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM = [
  "أنت كاتب محتوى سوشيال عربي من الطراز الأول.",
  "تعيد كتابة المنشور بنفس المعنى والحقائق دون اختراع أي معلومة جديدة (لا أسعار ولا أرقام ولا مواعيد لم ترد في الأصل).",
  "ممنوع تماماً: Markdown (** ## - جداول)، أكواد، JSON، روابط صور، أي كلام موجّه لصاحب الحساب.",
  "المخرج = نص المنشور فقط، جاهز للنسخ واللصق في المنصة، بأسطر قصيرة وفقرات مفصولة.",
].join(" ");

/** يعيد نسخاً محسّنة مرتبة بالدرجة، مع الاحتفاظ بالأصل إن كان أفضل. */
export async function improvePost(input: ImproveInput): Promise<ImproveResult> {
  const original = sanitizePostBody(input.text) || input.text.trim();
  const base = scorePost({
    text: original,
    provider: input.provider,
    hasMedia: input.hasMedia ?? false,
    bannedWords: input.bannedWords ?? [],
  });

  const count = Math.min(3, Math.max(1, input.variants ?? 2));
  const rules = rulesFor(base, input);

  const drafts = await Promise.all(
    ANGLES.slice(0, count).map(async (angle) => {
      try {
        const raw = await freeChat(
          "sonny",
          [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: [
                "أعد كتابة المنشور التالي ليحقق أعلى جودة نشر ممكنة.",
                rules,
                `الزاوية المطلوبة لهذه النسخة: ${angle}`,
                "",
                "المنشور الأصلي:",
                original,
              ].join("\n"),
            },
          ],
          { maxTokens: 900, timeoutMs: 45_000 },
        );
        const text = sanitizePostBody(raw);
        if (!text || text.length < 30) return null;
        const report = scorePost({
          text,
          provider: input.provider,
          hasMedia: input.hasMedia ?? false,
          bannedWords: input.bannedWords ?? [],
        });
        return { text, score: report.score, grade: report.grade, angle } satisfies ImproveVariant;
      } catch {
        return null;
      }
    }),
  );

  const variants = drafts
    .filter((v): v is ImproveVariant => !!v)
    .sort((a, b) => b.score - a.score);

  const best = variants[0];
  const fixed = best
    ? base.checks
        .filter((c) => c.severity !== "pass")
        .filter((c) => {
          const after = scorePost({
            text: best.text,
            provider: input.provider,
            hasMedia: input.hasMedia ?? false,
            bannedWords: input.bannedWords ?? [],
          }).checks.find((x) => x.id === c.id);
          return after?.severity === "pass";
        })
        .map((c) => c.label)
    : [];

  return { before: { score: base.score, grade: base.grade }, variants, fixed };
}
