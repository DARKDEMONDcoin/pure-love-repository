import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CalendarDays,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Loader2,
  Send,
  Sparkles,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
  Film,
  Wand2,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ConnectNow } from "@/components/app/ConnectNow";
import { PostMediaGallery, type PostMedia } from "@/components/app/PostMediaGallery";
import { ReelStudio } from "@/components/app/ReelStudio";

import { AppIcon, appLabel } from "@/components/site/AppIcon";
import { PostQuality } from "@/components/app/PostQuality";
import { useConnectedAccounts, useSocialPosts, useWorkspace } from "@/lib/data";
import { adaptForProvider, bestTimeFor, extractPostText } from "@/lib/post-format";
import { PUBLISHABLE, requestedPublishTargets, providerLabel } from "@/lib/platforms";
import {
  publishSocialNow,
  scheduleSocialPost,
  uploadSocialMedia,
} from "@/lib/social-queue.functions";
import { generateMedia } from "@/lib/media.functions";
import { bestPostingTimes } from "@/lib/best-time.functions";
import { saveLearningFeedback } from "@/lib/learning.functions";

type BestTimes = {
  source: "audience" | "history" | "baseline";
  samples: number;
  note: string;
  slots: { at: string; hour: number; weekday: number; score: number }[];
};

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** يلتقط أول صورة داخل المخرج (رابط مباشر أو صيغة ماركداون). */
function imageFromOutput(text: string | null | undefined): string | null {
  if (!text) return null;
  const md = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.exec(text);
  if (md?.[1]) return md[1];
  const raw = /(https?:\/\/\S+\.(?:png|jpe?g|webp))/i.exec(text);
  return raw?.[1] ?? null;
}

/** يُبقي نص المنشور وحده: بلا ماركداون ولا تعليق الموظف الموجّه للمستخدم. */
function cleanBody(text: string): string {
  return extractPostText(text);
}

function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Props = {
  workspaceId: string;
  employeeId: string;
  taskId?: string | null;
  /** القناة التي اقترحها الموظف. */
  channel: string;
  /** رسالة المستخدم الأصلية — لنفهم المنصة التي طلبها هو بالضبط. */
  request?: string | null;
  body: string;
  onPublished?: () => void;
  defaultOpen?: boolean;
};

type Media = PostMedia & { label: string };

/**
 * لوحة النشر: تحترم المنصة التي طلبها المستخدم (لا تبدّلها بغيرها صامتةً)، وتترك له
 * كامل الحرية: تعديل النص يدوياً، إبقاء الصورة المولّدة أو حذفها أو رفع صورة/فيديو من جهازه،
 * والنشر الآن أو جدولة أكثر من موعد.
 */
export function PublishPanel({
  workspaceId,
  employeeId,
  taskId,
  channel,
  request,
  body,
  onPublished,
  defaultOpen = false,
}: Props) {
  const qc = useQueryClient();
  const upload = useServerFn(uploadSocialMedia);
  const publishNow = useServerFn(publishSocialNow);
  const schedulePost = useServerFn(scheduleSocialPost);
  const saveFeedback = useServerFn(saveLearningFeedback);
  const { data: accounts, isLoading } = useConnectedAccounts(workspaceId);
  const { data: socialPosts } = useSocialPosts(workspaceId);
  const { data: workspace } = useWorkspace();

  const connected = useMemo(
    () =>
      (accounts ?? [])
        .map((a) => a.provider)
        .filter((p): p is (typeof PUBLISHABLE)[number] =>
          (PUBLISHABLE as readonly string[]).includes(p),
        ),
    [accounts],
  );

  /** المنصات التي طلبها المستخدم بكلامه، ثم قناة الموظف، بهذا الترتيب. */
  const requested = useMemo(() => {
    const fromUser = request ? requestedPublishTargets(request) : [];
    const list = [...fromUser];
    if (!list.length && (PUBLISHABLE as readonly string[]).includes(channel))
      list.push(channel as never);
    return [...new Set(list)];
  }, [request, channel]);

  const missing = requested.filter((p) => !connected.includes(p as never));

  const [picked, setPicked] = useState<string[] | null>(null);
  const active = useMemo(() => {
    if (picked) return picked.filter((p) => connected.includes(p as never));
    // لا نبدّل المنصة المطلوبة بأخرى: إن لم تكن مربوطة، نُظهر زر الربط بدل النشر في مكان آخر.
    const wanted = requested.filter((p) => connected.includes(p as never));
    if (wanted.length) return wanted;
    return requested.length ? [] : connected.slice(0, 1);
  }, [picked, connected, requested]);

  const toggle = (p: string) =>
    setPicked((prev) => {
      const base = prev ?? active;
      return base.includes(p) ? base.filter((x) => x !== p) : [...base, p];
    });

  // النص قابل للتعديل يدوياً دائماً.
  const [text, setText] = useState(() => cleanBody(body));
  const [editing, setEditing] = useState(false);
  useEffect(() => setText(cleanBody(body)), [body]);

  // الوسائط: أكثر من صورة/فيديو معاً — الصورة المولّدة تُقترح ويمكن حذفها أو إضافة غيرها.
  const generated = imageFromOutput(body);
  const [media, setMedia] = useState<Media[]>(() =>
    generated ? [{ url: generated, kind: "image", label: "الصورة المولّدة" }] : [],
  );
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // توليد صور بالذكاء الاصطناعي: تلقائياً من نص المنشور، أو من وصف يكتبه المستخدم.
  const makeMedia = useServerFn(generateMedia);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiCount, setAiCount] = useState(1);
  const [aiAspect, setAiAspect] = useState<"square" | "portrait" | "landscape" | "story">("square");
  const [aiBusy, setAiBusy] = useState<"auto" | "manual" | null>(null);

  const addMedia = (items: Media[]) =>
    setMedia((prev) => {
      const seen = new Set(prev.map((m) => m.url));
      return [...prev, ...items.filter((m) => !seen.has(m.url))].slice(0, 10);
    });
  const dropMedia = (url: string) => setMedia((prev) => prev.filter((m) => m.url !== url));

  // مواعيد متعددة: المستخدم يختار الكمية والأوقات التي يريدها.
  const [slots, setSlots] = useState<string[]>(() => [
    localInputValue(new Date(Date.now() + 3_600_000)),
  ]);
  const [scheduleMode, setScheduleMode] = useState<"single" | "repeat">("single");
  const [repeatCount, setRepeatCount] = useState(6);
  const [repeatDays, setRepeatDays] = useState<number[]>([1, 3, 5]);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [busy, setBusy] = useState<"now" | "later" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // لوحة النشر اختيارية تماماً: لا تفتح إلا إذا أراد المستخدم نشر هذا الرد.
  const [open, setOpen] = useState(defaultOpen);

  // أفضل وقت حقيقي محسوب من جمهور المستخدم/سجلّه.
  const askBestTimes = useServerFn(bestPostingTimes);
  const [bestTimes, setBestTimes] = useState<BestTimes | null>(null);
  const [loadingTimes, setLoadingTimes] = useState(false);

  const done = (message: string) => {
    setNote(message);
    void qc.invalidateQueries({ queryKey: ["social-posts", workspaceId] });
    void qc.invalidateQueries({ queryKey: ["tasks", workspaceId] });
    onPublished?.();
  };

  /** يجلب أفضل المواعيد الحقيقية للمنصة الأولى المختارة (جمهورك ← سجلّك ← متوسطات). */
  const loadBestTimes = async () => {
    const target = active[0];
    if (!target) return;
    setLoadingTimes(true);
    setNote(null);
    try {
      const result = (await askBestTimes({
        data: {
          workspaceId,
          provider: target,
          tzOffsetMinutes: -new Date().getTimezoneOffset(),
        },
      })) as BestTimes;
      setBestTimes(result);
    } catch (e) {
      // تعذّر الحساب الحقيقي: نرجع لمتوسط المنصة بدل ترك المستخدم بلا اقتراح.
      const at = bestTimeFor(target);
      setBestTimes({
        source: "baseline",
        samples: 0,
        note: e instanceof Error ? e.message : "تعذّر حساب بيانات جمهورك الآن.",
        slots: [{ at: at.toISOString(), hour: at.getHours(), weekday: at.getDay(), score: 0 }],
      });
    } finally {
      setLoadingTimes(false);
    }
  };

  /** يطبّق موعداً مقترحاً على خانة محددة (والمستخدم حرّ في تعديله بعدها). */
  const applySlot = (index: number, iso: string) =>
    setSlots((all) => all.map((v, i) => (i === index ? localInputValue(new Date(iso)) : v)));

  /** إزاحة سريعة: نفس التوقيت بعد عدد أيام. */
  const shiftDays = (index: number, days: number) =>
    setSlots((all) =>
      all.map((v, i) =>
        i === index ? localInputValue(new Date(new Date(v).getTime() + days * 86_400_000)) : v,
      ),
    );

  const buildRepeatedSlots = () => {
    const first = new Date(slots[0] ?? Date.now() + 3_600_000);
    if (Number.isNaN(first.getTime()) || !repeatDays.length) {
      setNote("اختر موعد بداية ويوماً واحداً على الأقل.");
      return;
    }
    const next: string[] = [];
    const cursor = new Date(first);
    while (next.length < Math.min(60, repeatCount)) {
      if (repeatDays.includes(cursor.getDay()) && cursor.getTime() > Date.now()) {
        next.push(localInputValue(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    setSlots(next);
    setNote(`جهّزنا ${next.length.toLocaleString("ar-EG")} موعداً ويمكنك تعديل أي موعد قبل الحفظ.`);
  };

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const leading = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    return [
      ...Array.from({ length: leading }, () => null),
      ...Array.from({ length: count }, (_, index) => new Date(year, month, index + 1)),
    ];
  }, [calendarMonth]);
  const dateKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const calendarEntries = useMemo(
    () => [
      ...(socialPosts ?? []).map((post) => ({
        id: post.id,
        at: new Date(post.scheduled_at),
        provider: post.provider,
        status: post.status,
      })),
      ...slots.map((slot, index) => ({
        id: `draft-${index}`,
        at: new Date(slot),
        provider: active[0] ?? "instagram",
        status: "draft",
      })),
    ],
    [socialPosts, slots, active],
  );

  const onFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setUploading(true);
    setNote(null);
    try {
      const added: Media[] = [];
      for (const file of list.slice(0, 10)) {
        const fd = new FormData();
        fd.set("workspaceId", workspaceId);
        fd.set("file", file);
        const r = await upload({ data: fd });
        added.push({ url: r.url, kind: r.kind, label: r.name });
      }
      addMedia(added);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "تعذّر رفع الملف.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /** يولّد صوراً: تلقائياً من نص المنشور، أو من وصف كتبه المستخدم بنفسه. */
  const runGenerate = async (mode: "auto" | "manual") => {
    const prompt =
      mode === "manual"
        ? aiPrompt.trim()
        : text
            .replace(/#[\p{L}\p{N}_]+/gu, " ")
            .trim()
            .slice(0, 600);
    if (prompt.length < 3) {
      setNote(
        mode === "manual" ? "اكتب وصف الصورة أولاً." : "نص المنشور قصير جداً لتوليد صورة منه.",
      );
      return;
    }
    setAiBusy(mode);
    setNote(null);
    try {
      const r = await makeMedia({
        data: {
          workspaceId,
          prompt,
          count: mode === "manual" ? aiCount : 1,
          aspect: aiAspect,
          mode: mode === "manual" ? "literal" : "enhanced",
        },
      });
      if (!r.urls.length) throw new Error("تعذّر توليد الصورة — أعد المحاولة.");
      addMedia(
        r.urls.map((url, i) => ({
          url,
          kind: "image" as const,
          label: mode === "manual" ? `صورتك ${i + 1}` : "صورة مولّدة",
        })),
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "تعذّر توليد الصورة.");
    } finally {
      setAiBusy(null);
    }
  };

  const run = async (mode: "now" | "later", providers = active) => {
    if (!providers.length) return;
    if (!text.trim()) {
      setNote("نص المنشور فارغ.");
      return;
    }
    setBusy(mode);
    setNote(null);

    const originalText = cleanBody(body);
    if (taskId && text.trim() !== originalText.trim()) {
      try {
        await saveFeedback({
          data: {
            workspaceId,
            taskId,
            employeeId,
            kind: "edited",
            originalText,
            editedText: text.trim(),
          },
        });
      } catch (error) {
        console.warn("[learning] edit feedback skipped:", error);
      }
    }

    const dates = mode === "later" ? slots.map((s) => new Date(s)) : [null];
    if (dates.some((d) => d && Number.isNaN(d.getTime()))) {
      setNote("أحد المواعيد غير صالح.");
      setBusy(null);
      return;
    }

    const ok: string[] = [];
    const failed: string[] = [];
    const images = media.filter((m) => m.kind === "image");
    const videos = media.filter((m) => m.kind === "video");
    const imageUrl = images[0]?.url ?? null;
    const videoUrl = videos[0]?.url ?? null;
    const mediaList = media.map((m) => ({ url: m.url, kind: m.kind }));

    for (const at of dates) {
      for (const provider of providers) {
        if (provider === "instagram" && !media.length) {
          failed.push(`${appLabel(provider)}: يحتاج صورة أو فيديو`);
          continue;
        }
        if (videoUrl && provider !== "facebook" && provider !== "instagram") {
          failed.push(`${appLabel(provider)}: نشر الفيديو متاح على فيسبوك وإنستجرام فقط`);
          continue;
        }
        const multi = provider === "facebook" || provider === "instagram";
        const base = {
          workspaceId,
          employeeId,
          taskId: taskId ?? null,
          provider,
          body: adaptForProvider(provider, text.trim()),
          imageUrl,
          videoUrl,
          media: multi ? mediaList : imageUrl ? [{ url: imageUrl, kind: "image" as const }] : [],
        };

        try {
          if (at) await schedulePost({ data: { ...base, scheduledAt: at.toISOString() } });
          else await publishNow({ data: base });
          ok.push(
            at
              ? `${appLabel(provider)} (${at.toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" })})`
              : appLabel(provider),
          );
        } catch (e) {
          failed.push(`${appLabel(provider)}: ${e instanceof Error ? e.message : "تعذّر التنفيذ"}`);
        }
      }
    }

    if (taskId && ok.length) {
      try {
        await saveFeedback({
          data: {
            workspaceId,
            taskId,
            employeeId,
            kind: mode === "now" ? "published" : "approved",
            reason: mode === "now" ? "نُشر المخرج بنجاح" : "اعتمد المالك المخرج وجدوله للنشر",
            metrics: { successfulTargets: ok.length, failedTargets: failed.length, mode },
          },
        });
      } catch (error) {
        console.warn("[learning] publish feedback skipped:", error);
      }
    }

    const head = ok.length
      ? mode === "later"
        ? `تمت الجدولة ⏱ ${ok.join("، ")}`
        : `تم النشر على ${ok.join("، ")} ✅`
      : "";
    done([head, ...failed].filter(Boolean).join("\n"));
    setBusy(null);
  };

  // «اربط وانشر» أمر واحد: بعد اكتمال OAuth وظهور الحساب، ننفذ النشر مرة واحدة.
  useEffect(() => {
    if (isLoading || busy || !connected.length) return;
    const key = `publish-after-connect:${workspaceId}`;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { provider?: unknown; createdAt?: unknown };
      const provider = typeof pending.provider === "string" ? pending.provider : null;
      const createdAt = typeof pending.createdAt === "number" ? pending.createdAt : 0;
      if (!provider || Date.now() - createdAt > 15 * 60 * 1000) {
        sessionStorage.removeItem(key);
        return;
      }
      if (!connected.includes(provider as (typeof PUBLISHABLE)[number])) return;
      sessionStorage.removeItem(key);
      setPicked([provider]);
      setOpen(true);
      void run("now", [provider]);
    } catch {
      sessionStorage.removeItem(key);
    }
    // run intentionally uses the current post text/media captured after the account query refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, connected, workspaceId]);

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> نتحقق من حساباتك المربوطة…
      </p>
    );
  }

  const chipClass = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
      on ? "border-foreground bg-foreground text-background" : "border-border hover:bg-secondary"
    }`;

  // النشر اختيار المستخدم وحده: نعرض زراً هادئاً، ولا تفتح اللوحة إلا بطلبه.
  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-xs font-bold hover:bg-secondary"
        >
          <Send className="size-3.5" /> انشر هذا المنشور
        </button>
        <span className="text-[11px] text-muted-foreground">
          اختياري — أنت تختار المنصة واليوم والساعة.
        </span>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-border bg-secondary/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-bold text-muted-foreground">خيارات النشر</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs font-bold text-muted-foreground hover:underline"
        >
          إخفاء
        </button>
      </div>
      <div className="post-publisher-media-first">
        <PostMediaGallery
          media={media}
          onRemove={dropMedia}
          onError={(url) => {
            dropMedia(url);
            setNote("أُزيلت وسيطة تعذّر تحميلها. يمكنك رفع بديل أو توليد صورة جديدة.");
          }}
        />
      </div>
      {/* المنصات: كل منصات النشر المدعومة كخيارات — والمطلوب صراحةً مُبرَز */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-muted-foreground">انشر على</span>
        {(PUBLISHABLE as readonly string[]).map((p) =>
          connected.includes(p as never) ? (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              aria-pressed={active.includes(p)}
              className={chipClass(active.includes(p))}
            >
              <AppIcon name={p} className="size-3.5" />
              {appLabel(p)}
              {requested.includes(p as never) ? (
                <span className="rounded-full bg-primary/20 px-1.5 text-[10px] text-primary">
                  طلبته
                </span>
              ) : null}
            </button>
          ) : (
            <ConnectNow
              key={p}
              workspaceId={workspaceId}
              provider={p}
              size="sm"
              label={`${providerLabel(p)} · اربطه`}
              className={`inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-xs font-bold hover:bg-secondary ${
                requested.includes(p as never)
                  ? "border-amber/60 bg-amber/10 text-ink-soft"
                  : "border-border text-muted-foreground"
              }`}
            />
          ),
        )}
      </div>
      {missing.length && !active.length ? (
        <p className="mt-2 text-xs font-bold text-coral">
          طلبت النشر على {missing.map(providerLabel).join(" و")} وهو غير مربوط بعد — لن نبدّله بمنصة
          أخرى دون إذنك. اربطه أو اختر منصة أخرى يدوياً.
        </p>
      ) : null}

      {/* النص */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-muted-foreground">نص المنشور</span>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="inline-flex items-center gap-1 text-xs font-bold hover:underline"
          >
            <Pencil className="size-3.5" /> {editing ? "إنهاء التعديل" : "عدّل يدوياً"}
          </button>
        </div>
        {editing ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
            dir="auto"
            className="mt-2 w-full rounded-xl border border-border bg-card p-3 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-foreground/20"
          />
        ) : (
          <p
            className="mt-2 line-clamp-4 whitespace-pre-line rounded-xl bg-card/60 p-3 text-sm leading-relaxed text-ink-soft"
            dir="auto"
          >
            {text}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {text.length.toLocaleString("en-US")} حرف
          {active.includes("x") ? " · نسخة إكس تُقصَّر تلقائياً إلى ٢٨٠ حرفاً" : ""}
        </p>
        <PostQuality
          text={text}
          providers={active}
          hasMedia={media.length > 0}
          bannedWords={workspace?.banned_words ?? []}
          tone={workspace?.tone ?? undefined}
          industry={workspace?.industry ?? undefined}
          onApply={(next) => setText(next)}
        />
      </div>

      {/* الوسائط */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-muted-foreground">
            الصور والفيديو {media.length ? `(${media.length.toLocaleString("en-US")}/10)` : ""}
          </span>
          {media.length ? (
            <button
              type="button"
              onClick={() => setMedia([])}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-muted-foreground hover:text-coral"
            >
              <Trash2 className="size-3.5" /> امسح الكل
            </button>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || media.length >= 10}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-bold hover:bg-secondary disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ImagePlus className="size-3.5" />
            )}
            ارفع صوراً/فيديو
          </button>
          <button
            type="button"
            onClick={() => void runGenerate("auto")}
            disabled={!!aiBusy || media.length >= 10}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-bold hover:bg-secondary disabled:opacity-60"
          >
            {aiBusy === "auto" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            ولّد صورة من نص المنشور
          </button>
          <button
            type="button"
            onClick={() => setAiOpen((v) => !v)}
            aria-expanded={aiOpen}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
              aiOpen
                ? "border-foreground bg-foreground text-background"
                : "border-border hover:bg-secondary"
            }`}
          >
            <Wand2 className="size-3.5" /> ولّد صورة بوصفي
          </button>
          {generated && !media.some((m) => m.url === generated) ? (
            <button
              type="button"
              onClick={() =>
                addMedia([{ url: generated, kind: "image", label: "الصورة المولّدة" }])
              }
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-bold hover:bg-secondary"
            >
              <Sparkles className="size-3.5" /> أعد الصورة المولّدة
            </button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => void onFiles(e.target.files)}
          />
          <button
            type="button"
            disabled
            title="سيُربط مزود توليد الفيديو قريباً"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-bold opacity-60"
          >
            <Clapperboard className="size-3.5" /> فيديو بالذكاء الاصطناعي · قريباً
          </button>
        </div>

        {aiOpen ? (
          <div className="mt-3 rounded-2xl border border-border bg-card/70 p-3">
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              rows={2}
              dir="auto"
              placeholder="صف الصورة التي تريدها: مثلاً «طبق كبسة بلحم على طاولة خشبية بإضاءة دافئة»"
              className="w-full resize-none rounded-xl border border-border bg-background p-2.5 text-sm outline-none focus:ring-2 focus:ring-foreground/20"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground">
                عدد الصور
                <select
                  value={aiCount}
                  onChange={(e) => setAiCount(Number(e.target.value))}
                  className="rounded-full border border-border bg-card px-2.5 py-1.5 text-xs font-bold text-foreground"
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground">
                المقاس
                <select
                  value={aiAspect}
                  onChange={(e) => setAiAspect(e.target.value as typeof aiAspect)}
                  className="rounded-full border border-border bg-card px-2.5 py-1.5 text-xs font-bold text-foreground"
                >
                  <option value="square">مربع (منشور)</option>
                  <option value="portrait">طولي</option>
                  <option value="landscape">عرضي</option>
                  <option value="story">ستوري / ريلز</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => void runGenerate("manual")}
                disabled={!!aiBusy || !aiPrompt.trim()}
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-1.5 text-xs font-bold text-background disabled:opacity-60"
              >
                {aiBusy === "manual" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
                ولّد الآن
              </button>
            </div>
          </div>
        ) : null}

        {media.some((m) => m.kind === "video") ? (
          <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Film className="size-3.5" /> الفيديو يُنشر على فيسبوك وإنستجرام (Reels عمودي حتى ٩٠
            ثانية).
          </p>
        ) : null}
        {media.length > 1 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            أكثر من وسيطة تُنشر كألبوم على فيسبوك وكاروسيل على إنستجرام — أما باقي المنصات فتأخذ
            الصورة الأولى.
          </p>
        ) : null}
        {media.filter((item) => item.kind === "image").length >= 2 ? (
          <div className="mt-3">
            <ReelStudio
              workspaceId={workspaceId}
              images={media.filter((item) => item.kind === "image").map((item) => item.url)}
              aspect={aiAspect}
              attached={media.map((item) => item.url)}
              onAttach={(url) => addMedia([{ url, kind: "video", label: "ريلز من صورك" }])}
            />
          </div>
        ) : null}
        {active.includes("instagram") && !media.length ? (
          <p className="mt-2 text-xs text-muted-foreground">
            إنستجرام يتطلّب صورة أو فيديو — ولّد صورة أو ارفع من جهازك.
          </p>
        ) : null}
      </div>

      {/* المواعيد */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-muted-foreground">الجدولة</span>
          <button
            type="button"
            onClick={() => setCalendarOpen((value) => !value)}
            className="inline-flex items-center gap-1.5 text-xs font-bold hover:underline"
          >
            <CalendarDays className="size-3.5" /> {calendarOpen ? "إخفاء التقويم" : "عرض التقويم"}
          </button>
        </div>
        <div className="mt-2 inline-flex rounded-lg border border-border bg-card p-1">
          {(["single", "repeat"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setScheduleMode(mode)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold ${scheduleMode === mode ? "bg-foreground text-background" : "text-muted-foreground"}`}
            >
              {mode === "single" ? "موعد أو مواعيد" : "تكرار حسب الأيام"}
            </button>
          ))}
        </div>
        {scheduleMode === "repeat" ? (
          <div className="mt-3 rounded-xl border border-border bg-card/60 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs font-bold text-muted-foreground">
                عدد مرات النشر
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={repeatCount}
                  onChange={(event) =>
                    setRepeatCount(Math.max(1, Math.min(60, Number(event.target.value) || 1)))
                  }
                  className="mt-1 block w-24 rounded-lg border border-border bg-background px-3 py-2 text-foreground"
                />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((day, dayIndex) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={repeatDays.includes(dayIndex)}
                    onClick={() =>
                      setRepeatDays((days) =>
                        days.includes(dayIndex)
                          ? days.filter((item) => item !== dayIndex)
                          : [...days, dayIndex],
                      )
                    }
                    className={`rounded-full border px-2.5 py-1.5 text-[11px] font-bold ${repeatDays.includes(dayIndex) ? "border-foreground bg-foreground text-background" : "border-border"}`}
                  >
                    {day}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={buildRepeatedSlots}
                className="rounded-lg border border-border px-3 py-2 text-xs font-bold hover:bg-secondary"
              >
                إنشاء المواعيد
              </button>
            </div>
          </div>
        ) : null}
        {calendarOpen ? (
          <div className="post-inline-calendar">
            <div className="post-inline-calendar-head">
              <button
                type="button"
                onClick={() =>
                  setCalendarMonth((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))
                }
                aria-label="الشهر السابق"
              >
                <ChevronRight className="size-4" />
              </button>
              <strong>
                {calendarMonth.toLocaleDateString("ar-EG", { month: "long", year: "numeric" })}
              </strong>
              <button
                type="button"
                onClick={() =>
                  setCalendarMonth((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))
                }
                aria-label="الشهر التالي"
              >
                <ChevronLeft className="size-4" />
              </button>
            </div>
            <div className="post-calendar-weekdays">
              {WEEKDAYS.map((day) => (
                <span key={day}>{day.slice(0, 2)}</span>
              ))}
            </div>
            <div className="post-calendar-grid">
              {calendarDays.map((day, index) => {
                if (!day) return <span key={`empty-${index}`} />;
                const key = dateKey(day);
                const entries = calendarEntries.filter(
                  (entry) => !Number.isNaN(entry.at.getTime()) && dateKey(entry.at) === key,
                );
                return (
                  <button
                    key={key}
                    type="button"
                    className={`post-calendar-day ${selectedDay === key ? "is-selected" : ""}`}
                    onClick={() => setSelectedDay((value) => (value === key ? null : key))}
                  >
                    <b>{day.getDate().toLocaleString("ar-EG")}</b>
                    {entries.length ? <span>{entries.length.toLocaleString("ar-EG")}</span> : null}
                  </button>
                );
              })}
            </div>
            {selectedDay ? (
              <div className="post-inline-calendar-list">
                {calendarEntries
                  .filter(
                    (entry) =>
                      !Number.isNaN(entry.at.getTime()) && dateKey(entry.at) === selectedDay,
                  )
                  .map((entry) => (
                    <div key={entry.id} className="post-inline-calendar-item">
                      <AppIcon name={entry.provider} className="size-4" />
                      <span>
                        {entry.at.toLocaleTimeString("ar-EG", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <small>
                        {entry.status === "published"
                          ? "منشور"
                          : entry.status === "failed"
                            ? "فشل"
                            : entry.status === "draft"
                              ? "قيد الإعداد"
                              : "مجدول"}
                      </small>
                    </div>
                  ))}
              </div>
            ) : null}
            <Link to="/app/calendar" className="post-calendar-link">
              افتح صفحة التقويم لإدارة كل المحتوى لاحقاً
            </Link>
          </div>
        ) : null}
        <div className="mt-2 space-y-3">
          {slots.map((s, i) => {
            const [datePart = "", timePart = "00:00"] = s.split("T");
            const [hourPart = "00", minutePart = "00"] = timePart.split(":");
            const setPart = (next: string) =>
              setSlots((all) => all.map((v, j) => (j === i ? next : v)));
            return (
              <div key={i} className="rounded-2xl border border-border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={datePart}
                    onChange={(e) => setPart(`${e.target.value}T${hourPart}:${minutePart}`)}
                    aria-label={`يوم النشر ${i + 1}`}
                    className="rounded-full border border-border bg-card px-3 py-2 text-sm"
                  />
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1.5">
                    <select
                      value={hourPart}
                      onChange={(e) => setPart(`${datePart}T${e.target.value}:${minutePart}`)}
                      aria-label={`ساعة النشر ${i + 1}`}
                      className="bg-transparent px-1 text-sm font-bold outline-none"
                    >
                      {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    <span className="text-muted-foreground">:</span>
                    <select
                      value={minutePart}
                      onChange={(e) => setPart(`${datePart}T${hourPart}:${e.target.value}`)}
                      aria-label={`دقيقة النشر ${i + 1}`}
                      className="bg-transparent px-1 text-sm font-bold outline-none"
                    >
                      {["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map(
                        (m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ),
                      )}
                    </select>
                  </span>
                  <button
                    type="button"
                    onClick={() => shiftDays(i, 1)}
                    className="rounded-full border border-border px-3 py-2 text-xs font-bold hover:bg-secondary"
                  >
                    +يوم
                  </button>
                  <button
                    type="button"
                    onClick={() => shiftDays(i, 7)}
                    className="rounded-full border border-border px-3 py-2 text-xs font-bold hover:bg-secondary"
                  >
                    +أسبوع
                  </button>
                  <button
                    type="button"
                    onClick={() => void loadBestTimes()}
                    disabled={!active.length || loadingTimes}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-bold hover:bg-secondary disabled:opacity-60"
                  >
                    {loadingTimes ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    أفضل وقت لجمهورك
                  </button>
                  {slots.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setSlots((all) => all.filter((_, j) => j !== i))}
                      aria-label="حذف الموعد"
                      className="ms-auto rounded-full p-2 text-muted-foreground hover:bg-secondary"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  ) : null}
                </div>
                {bestTimes?.slots.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {bestTimes.slots.map((slot) => (
                      <button
                        key={slot.at}
                        type="button"
                        onClick={() => applySlot(i, slot.at)}
                        className="rounded-full border border-jade/40 bg-jade/10 px-3 py-1.5 text-[11px] font-bold text-jade-deep hover:bg-jade/20"
                      >
                        {WEEKDAYS[slot.weekday]} {String(slot.hour).padStart(2, "0")}:00
                      </button>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {Number.isNaN(new Date(s).getTime())
                    ? "الموعد غير مكتمل — اختر اليوم والساعة."
                    : new Date(s).toLocaleString("ar-EG", {
                        dateStyle: "full",
                        timeStyle: "short",
                      })}
                </p>
              </div>
            );
          })}
          {slots.length < 60 ? (
            <button
              type="button"
              onClick={() =>
                setSlots((all) => [
                  ...all,
                  localInputValue(
                    new Date(new Date(all[all.length - 1] ?? Date.now()).getTime() + 86_400_000),
                  ),
                ])
              }
              className="inline-flex items-center gap-1 text-xs font-bold hover:underline"
            >
              <Plus className="size-3.5" /> موعد آخر
            </button>
          ) : null}
        </div>

        {bestTimes ? (
          <p className="mt-2 text-[11px] text-muted-foreground">{bestTimes.note}</p>
        ) : null}
      </div>

      {/* الإجراءات */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run("now")}
          disabled={!!busy || uploading || !active.length}
          className="inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-bold text-background disabled:opacity-60"
        >
          {busy === "now" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          انشر الآن
        </button>
        <button
          type="button"
          onClick={() => void run("later")}
          disabled={!!busy || uploading || !active.length}
          className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm font-bold transition-colors hover:bg-secondary disabled:opacity-60"
        >
          {busy === "later" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CalendarClock className="size-4" />
          )}
          جدولة {slots.length > 1 ? `(${slots.length.toLocaleString("en-US")} مواعيد)` : ""}
        </button>
      </div>

      {note ? (
        <p className="mt-3 whitespace-pre-line text-xs font-bold text-ink-soft">{note}</p>
      ) : null}
    </div>
  );
}
