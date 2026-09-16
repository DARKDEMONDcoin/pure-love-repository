/**
 * «الوعي اللحظي»: يعطي كل موظف إحساساً حقيقياً بالزمن (تاريخ وساعة بالتوقيت المحلي
 * للعلامة + التاريخ الهجري + الموسم القادم) وبالأحداث الجارية في العالم عبر بحث حي
 * حقيقي (SearXNG ثم نتائج البحث ثم ويكيبيديا) — بلا اختلاق ولا معلومات قديمة.
 */

const WEEK = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function fmt(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions, locale = "ar-EG") {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}

/** كتلة الزمن الدقيق — تُحقن دائماً في تعليمات كل موظف. */
export function nowBlock(timeZone = "Africa/Cairo"): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  const clock = `${get("hour")}:${get("minute")}`;
  const weekday = WEEK[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? "";
  const hijri = fmt(now, timeZone, { day: "numeric", month: "long", year: "numeric" }, "ar-SA-u-ca-islamic");
  const long = fmt(now, timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return [
    "## اللحظة الحالية (حقيقة مؤكدة — لا تخمّن الزمن أبداً)",
    `- الآن: ${long} — الساعة ${clock} بتوقيت ${timeZone}.`,
    `- التاريخ الميلادي: ${iso} (${weekday}). التاريخ الهجري: ${hijri}.`,
    "- كل تعبير زمني في ردك (اليوم، غداً، هذا الأسبوع، أمس، بعد ٣ أيام) يُحسب من هذه اللحظة بالضبط، واذكر التاريخ صراحةً عند الجدولة.",
    "- ممنوع أن تقول إنك «لا تعرف التاريخ» أو إن معلوماتك تتوقف عند سنة معيّنة.",
  ].join("\n");
}

/** هل يحتاج الطلب حقائق لحظية من العالم (أخبار، رياضة، أسعار، ترند، «آخر/أحدث»)؟ */
export function needsLiveFacts(text: string): boolean {
  return /(آخر|أحدث|احدث|اخر)\s|النهارده|النهاردة|اليوم|امبارح|أمس|بكرة|غدا|غداً|الأسبوع ده|هذا الأسبوع|خبر|أخبار|اخبار|عاجل|ترند|ترندات|trending|مباراة|ماتش|الماتش|الدوري|كأس|بطولة|فاز|هدف|نتيجة المباراة|سعر|أسعار|اسعار|الدولار|الذهب|البورصة|مهرجان|حفل|إعلان|اطلاق|إطلاق|صدر|توفي|رحيل|انتخابات|الطقس|موسم|رمضان|العيد|الجمعة البيضاء|بلاك فرايداي|اليوم الوطني/u.test(
    text,
  );
}

/** ينظّف الرسالة إلى استعلام بحث قصير مفيد. */
function queryOf(text: string): string {
  return text
    .replace(/^(يا\s+\w+[،,]?\s*)/u, "")
    .replace(/(اكتب|اكتبلي|اعملي|اعمل|جهّز|جهز|منشور|بوست|بوستات|من فضلك|لو سمحت|عايز|عاوز|أريد)/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export type LiveRow = { title: string; url: string; snippet: string };

const STOP = new Set([
  "على","في","من","عن","الى","إلى","مع","هذا","هذه","اللي","التي","الذي","كان","اليوم","امس","أمس",
  "ماتش","نتيجة","اخر","آخر","أحدث","احدث","the","and","for","with","what","when",
]);

function norm(text: string) {
  return text
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u064B-\u0652]/g, "");
}

/** يبقي فقط النتائج التي تخص فعلاً موضوع السؤال — كثير من نسخ البحث تعيد ضجيجاً. */
function relevantRows(rows: LiveRow[], query: string): LiveRow[] {
  const tokens = norm(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  if (!tokens.length) return rows;
  return rows.filter((r) => {
    const hay = norm(`${r.title} ${r.snippet}`);
    return tokens.some((t) => hay.includes(t));
  });
}

/**
 * يجلب حقائق لحظية حقيقية عن موضوع الرسالة. يعيد كتلة جاهزة للحقن أو نصاً فارغاً
 * إن لم تُرجع أي مصادر شيئاً (فيقول الموظف ذلك بصراحة بدل الاختلاق).
 */
export async function liveFactsBlock(message: string, budgetMs = 13_000): Promise<string> {
  const q = queryOf(message);
  if (!q) return "";
  const started = Date.now();
  const rows: LiveRow[] = [];
  const left = () => budgetMs - (Date.now() - started);

  try {
    const { searxPoolSearch } = await import("./searx-pool.server");
    rows.push(...relevantRows(await searxPoolSearch(q, Math.min(budgetMs, 11_000)), q).slice(0, 8));
  } catch {
    /* نتابع بمصدر آخر */
  }

  if (rows.length < 3 && left() > 4_000) {
    try {
      const { serpSearch } = await import("./seo-research.server");
      const serp = await serpSearch(q);
      rows.push(
        ...relevantRows(
          serp.map((r) => ({
            title: r.title ?? r.url,
            url: r.url,
            snippet: (r as { snippet?: string }).snippet ?? "",
          })),
          q,
        ).slice(0, 6),
      );
    } catch {
      /* نتابع */
    }
  }

  if (!rows.length && left() > 3_000) {
    try {
      const { wikipediaSearch } = await import("./searx-pool.server");
      rows.push(...relevantRows(await wikipediaSearch(q), q).slice(0, 5));
    } catch {
      /* لا شيء */
    }
  }

  const seen = new Set<string>();
  const unique = rows.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, 8);


  if (!unique.length)
    return [
      "## حقائق لحظية",
      `بحثتَ الآن عن «${q}» ولم تُرجع محركات البحث نتائج موثوقة.`,
      "قل للمستخدم بصراحة في سطر واحد أنك لم تجد مصدراً مؤكداً لهذا الحدث، واطلب منه التفصيلة (النتيجة/الاسم/التاريخ) ثم نفّذ طلبه فوراً عليها. ممنوع اختلاق نتيجة أو رقم.",
    ].join("\n");

  return [
    `## حقائق لحظية من بحث حيّ نُفّذ الآن عن «${q}» (استخدمها كمصدر وحيد لأي حدث جارٍ)`,
    ...unique.map((r) => `- ${r.title}${r.snippet ? ` — ${r.snippet}` : ""} (${new URL(r.url).hostname})`),
    "اعتمد هذه النتائج حرفياً. إن تعارضت المصادر فاذكر الأرجح وقل إن التفاصيل قيد التأكيد. لا تضف أسماء أو أرقاماً غير موجودة هنا.",
  ].join("\n");
}
