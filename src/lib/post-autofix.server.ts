/**
 * إصلاح ذاتي آلي لمخرجات سِراج قبل أن يراها المستخدم.
 *
 * بدل الاعتماد على «راجع نفسك» داخل التعليمات فقط (النماذج تتجاهلها أحياناً)،
 * نفحص كل منشور بمقياس الجودة الحتمي (post-quality) وإن سقط في حاجز نشر أو
 * نزلت درجته عن العتبة، نطلب إعادة كتابة موجّهة بنقاط الفشل نفسها — نداء واحد
 * فقط، ولا نستبدل النص إلا إذا تحسّنت الدرجة فعلاً. فشل الإصلاح لا يعطّل الرد.
 */
import { scorePost } from "./post-quality";
import { freeChat } from "./nour-research.server";
import { normalizeChannel, PUBLISHABLE } from "./platforms";

type Post = { title?: string; kind?: string; channel?: string; body?: string } & Record<
  string,
  unknown
>;

const THRESHOLD = 72;

function providerOf(post: Post): string | null {
  const p = normalizeChannel(typeof post.channel === "string" ? post.channel : null);
  return p && (PUBLISHABLE as readonly string[]).includes(p) ? p : null;
}

/**
 * يفحص المخرجات ويصلح الضعيف منها. يعيد نفس المصفوفة مع النصوص المحسّنة.
 */
export async function autofixPosts(
  apiKey: string,
  posts: Post[],
  opts: { bannedWords?: string[]; dialect?: string; hasMedia?: boolean } = {},
): Promise<Post[]> {
  if (!posts.length) return posts;
  const banned = opts.bannedWords ?? [];
  /** وسائط فعلية: إمّا المستخدم أرفق/طلب صورة، أو المنشور نفسه يحمل وصف صورة. */
  const mediaOf = (post: Post) => {
    const img = post["image_prompt"];
    const vid = post["video_url"];
    return (
      Boolean(opts.hasMedia) ||
      (typeof img === "string" && img.trim().length > 10) ||
      (typeof vid === "string" && vid.trim().length > 5)
    );
  };


  const weak = posts
    .map((post, index) => ({ post, index, provider: providerOf(post) }))
    .filter((row): row is { post: Post; index: number; provider: string } => Boolean(row.provider))
    .map((row) => ({
      ...row,
      report: scorePost({
        text: String(row.post.body ?? ""),
        provider: row.provider,
        hasMedia: mediaOf(row.post),
        bannedWords: banned,
      }),
    }))
    .filter((row) => row.report.blockers.length > 0 || row.report.score < THRESHOLD)
    .slice(0, 4);


  if (!weak.length) return posts;

  const brief = weak
    .map(
      (row, i) =>
        [
          `### منشور ${i + 1} — المنصة: ${row.report.providerLabel} (الدرجة الحالية ${row.report.score}/100)`,
          "نقاط يجب إصلاحها:",
          ...row.report.checks
            .filter((c) => c.severity !== "pass")
            .map((c) => `- ${c.label}: ${c.hint}`),
          "النص الحالي:",
          String(row.post.body ?? ""),
        ].join("\n"),
    )
    .join("\n\n");

  try {
    const raw = await freeChat(
      apiKey,
      [
        {
          role: "system",
          content: [
            "أنت محرر سوشيال ميديا عربي محترف. مهمتك إعادة كتابة منشورات جاهزة للنشر بحيث تعالج نقاط الفشل المذكورة حرفياً.",
            "القواعد: نص جاهز للنشر فقط — بلا عناوين Markdown ولا نجوم ولا جداول ولا شرح ولا وصف صورة.",
            "لا تخترع أي رقم أو سعر أو موعد أو ادعاء غير موجود في النص الأصلي؛ حافظ على المعنى واللهجة والعرض.",
            opts.dialect ? `اللهجة المطلوبة: ${opts.dialect}.` : "",
            banned.length ? `كلمات ممنوعة تماماً: ${banned.join("، ")}.` : "",
            `أعد JSON فقط بالشكل: {"posts":[{"i":1,"body":"النص المحسّن"}]}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
        { role: "user", content: brief },
      ],
      { json: true, timeoutMs: 30_000, maxTokens: 1600, budgetMs: 38_000 },
    );

    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()) as {
      posts?: { i?: number; body?: string }[];
    };
    const out = posts.slice();
    for (const fix of parsed.posts ?? []) {
      const row = weak[(Number(fix.i) || 0) - 1];
      const body = typeof fix.body === "string" ? fix.body.trim() : "";
      if (!row || body.length < 20) continue;
      const after = scorePost({ text: body, provider: row.provider, hasMedia: mediaOf(row.post), bannedWords: banned });
      // لا نستبدل إلا بتحسّن حقيقي — حتى لا يفسد الإصلاح نصاً كان أفضل.
      if (after.score > row.report.score && after.blockers.length <= row.report.blockers.length) {
        out[row.index] = { ...row.post, body };
      }
    }
    return out;
  } catch (error) {
    console.warn("[autofix] skipped:", error instanceof Error ? error.message : error);
    return posts;
  }
}
