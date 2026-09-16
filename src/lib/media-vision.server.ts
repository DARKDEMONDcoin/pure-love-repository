/**
 * قراءة وسائط المستخدم: نمرّر الصور المرفقة إلى نموذج بصري ونعيد وصفاً نصياً موجزاً
 * لكل صورة، فيستطيع الموظف «رؤية» ما أرفقه المستخدم والبناء عليه بدل تجاهله.
 * الفيديو لا يُحلَّل بصرياً — نذكره بالرابط والاسم فقط.
 */

const LOVABLE = "https://ai.gateway.lovable.dev/v1/chat/completions";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const VISION_LOVABLE = "google/gemini-2.5-flash";
const VISION_GEMINI = "gemini-3.5-flash-lite";

type Attachment = { url: string; type: "image" | "video"; alt?: string | undefined };

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function callVision(
  endpoint: string,
  apiKey: string,
  model: string,
  parts: Part[],
): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "أنت محلّل بصري. صِف كل صورة مرفقة بدقة وباختصار بالعربية: ما تحتويه، الأشخاص/المنتجات، أي نص مكتوب داخلها حرفياً، الألوان والجو العام. أعد سطراً لكل صورة يبدأ بـ «صورة N:».",
        },
        { role: "user", content: parts },
      ],
    }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!res.ok) throw new Error(`${model}: ${res.status}`);
  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error(`${model}: رد فارغ`);
  return content.trim();
}

const MAX_INLINE_BYTES = 6 * 1024 * 1024;

/**
 * النماذج البصرية لا تستطيع جلب الروابط الموقّعة أو المحمية بـ robots،
 * فنجلب البايتات بأنفسنا ونمرّرها كـ data URL.
 */
async function inlineImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SahlMediaReader/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_INLINE_BYTES) return null;
    const base64 = Buffer.from(buf).toString("base64");
    return `data:${type};base64,${base64}`;
  } catch {
    return null;
  }
}

/** وصف نصي لوسائط المستخدم (حتى ١٠ عناصر) — سلسلة فارغة عند تعذّر التحليل. */
export async function describeUserMedia(attachments: Attachment[]): Promise<string> {
  const images = attachments.filter((a) => a.type === "image").slice(0, 10);
  const videos = attachments.filter((a) => a.type === "video").slice(0, 10);
  const videoNote = videos.length
    ? videos.map((v, i) => `فيديو ${i + 1}: ${v.alt || v.url}`).join(" · ")
    : "";

  if (!images.length) return videoNote;

  const inlined = (await Promise.all(images.map((a) => inlineImage(a.url)))).filter(
    (u): u is string => Boolean(u),
  );
  if (!inlined.length) return videoNote;

  const parts: Part[] = [
    {
      type: "text",
      text: `صِف هذه ${inlined.length} صورة/صور المرفقة من المستخدم، سطر لكل صورة.`,
    },
    ...inlined.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];

  try {
    const { providerKeys } = await import("./provider-keys.server");
    const keys = await providerKeys();
    let described = "";
    if (keys.lovable) {
      described = await callVision(LOVABLE, keys.lovable, VISION_LOVABLE, parts).catch(() => "");
    }
    if (!described && keys.gemini) {
      described = await callVision(GEMINI, keys.gemini, VISION_GEMINI, parts).catch(() => "");
    }
    return [described, videoNote].filter(Boolean).join(" · ");
  } catch (error) {
    console.warn("[media-vision] failed:", error instanceof Error ? error.message : error);
    return videoNote;
  }
}
