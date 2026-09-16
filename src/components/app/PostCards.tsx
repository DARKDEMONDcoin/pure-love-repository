/**
 * بطاقات المنشور الجاهزة داخل المحادثة: بطاقة لكل منصة تُشبه المنشور النهائي —
 * شعار المنصة، تعديل سريع بالقلم، جدولة بالساعة، وزر «انشر» — بلا مغادرة الشات.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CalendarClock,
  Check,
  ImagePlus,
  Loader2,
  Pencil,
  Send,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";

import { AppIcon, appLabel } from "@/components/site/AppIcon";
import { ConnectNow } from "@/components/app/ConnectNow";
import { PublishPanel, imageFromOutput } from "@/components/app/PublishPanel";
import { useConnectedAccounts } from "@/lib/data";
import { adaptForProvider, sanitizePostBody } from "@/lib/post-format";
import { PUBLISHABLE, providerLabel, requestedPublishTargets } from "@/lib/platforms";
import {
  publishSocialNow,
  scheduleSocialPost,
  uploadSocialMedia,
} from "@/lib/social-queue.functions";
import { saveLearningFeedback } from "@/lib/learning.functions";
import { cn } from "@/lib/utils";

type Media = { url: string; kind: "image" | "video" };

function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type CardState = {
  text: string;
  media: Media[];
  status: "idle" | "publishing" | "scheduling" | "published" | "scheduled";
  note: string | null;
};

export function PostCards({
  workspaceId,
  employeeId,
  taskId,
  request,
  body,
  channel,
}: {
  workspaceId: string;
  employeeId: string;
  taskId?: string | null;
  request?: string | null;
  body: string;
  channel?: string | undefined;
}) {
  const qc = useQueryClient();
  const publishNow = useServerFn(publishSocialNow);
  const schedule = useServerFn(scheduleSocialPost);
  const upload = useServerFn(uploadSocialMedia);
  const saveFeedback = useServerFn(saveLearningFeedback);
  const { data: accounts, isLoading } = useConnectedAccounts(workspaceId);

  const connected = useMemo(
    () => (accounts ?? []).map((a) => a.provider).filter((p) => PUBLISHABLE.includes(p as never)),
    [accounts],
  );

  /** المنصات التي طلبها المستخدم بكلامه، ثم قناة الموظف، ثم أول منصة مربوطة. */
  const targets = useMemo(() => {
    const wanted = [...(request ? requestedPublishTargets(request) : [])] as string[];
    if (!wanted.length && channel && PUBLISHABLE.includes(channel as never)) wanted.push(channel);
    if (!wanted.length) wanted.push(...connected.slice(0, 1));
    if (!wanted.length) wanted.push("instagram");
    return [...new Set(wanted)];
  }, [request, channel, connected]);

  const base = useMemo(() => sanitizePostBody(body).trim(), [body]);
  const generated = useMemo(() => imageFromOutput(body), [body]);

  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [when, setWhen] = useState(() => localInputValue(new Date(Date.now() + 3_600_000)));
  const [advanced, setAdvanced] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);

  useEffect(() => {
    setCards(
      Object.fromEntries(
        targets.map((p) => [
          p,
          {
            text: adaptForProvider(p, base),
            media: generated ? [{ url: generated, kind: "image" as const }] : [],
            status: "idle" as const,
            note: null,
          },
        ]),
      ),
    );
  }, [targets, base, generated]);

  const patch = (provider: string, next: Partial<CardState>) =>
    setCards((prev) => {
      const current = prev[provider];
      if (!current) return prev;
      return { ...prev, [provider]: { ...current, ...next } };
    });

  const act = async (provider: string, mode: "now" | "later") => {
    const card = cards[provider];
    if (!card) return;
    if (!card.text.trim()) return patch(provider, { note: "نص المنشور فارغ." });
    if (provider === "instagram" && !card.media.length)
      return patch(provider, { note: "إنستجرام يحتاج صورة أو فيديو مع المنشور." });

    const at = mode === "later" ? new Date(when) : null;
    if (at && Number.isNaN(at.getTime())) return patch(provider, { note: "الموعد غير صالح." });

    patch(provider, { status: mode === "now" ? "publishing" : "scheduling", note: null });
    const payload = {
      workspaceId,
      employeeId,
      taskId: taskId ?? null,
      provider,
      body: card.text.trim(),
      imageUrl: card.media.find((m) => m.kind === "image")?.url ?? null,
      videoUrl: card.media.find((m) => m.kind === "video")?.url ?? null,
      media: card.media,
    };
    try {
      if (at) await schedule({ data: { ...payload, scheduledAt: at.toISOString() } });
      else await publishNow({ data: payload });
      patch(provider, {
        status: at ? "scheduled" : "published",
        note: at
          ? `مجدول ${at.toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" })}`
          : "نُشر الآن",
      });
      setScheduling(null);
      void qc.invalidateQueries({ queryKey: ["social-posts", workspaceId] });
      void qc.invalidateQueries({ queryKey: ["tasks", workspaceId] });
      if (taskId) {
        await saveFeedback({
          data: {
            workspaceId,
            taskId,
            employeeId,
            kind: at ? "approved" : "published",
            reason: at ? "جدول المالك المنشور من بطاقة المحادثة" : "نشر المالك المنشور من المحادثة",
          },
        }).catch(() => undefined);
      }
    } catch (error) {
      patch(provider, {
        status: "idle",
        note: error instanceof Error ? error.message : "تعذّر التنفيذ.",
      });
    }
  };

  const pickFile = (provider: string) => {
    uploadTarget.current = provider;
    fileRef.current?.click();
  };

  const onFiles = async (files: FileList | null) => {
    const provider = uploadTarget.current;
    const list = Array.from(files ?? []);
    if (!provider || !list.length) return;
    setUploadingFor(provider);
    try {
      const added: Media[] = [];
      for (const file of list.slice(0, 10)) {
        const fd = new FormData();
        fd.set("workspaceId", workspaceId);
        fd.set("file", file);
        const r = await upload({ data: fd });
        added.push({ url: r.url, kind: r.kind });
      }
      const card = cards[provider];
      if (card) patch(provider, { media: [...card.media, ...added].slice(0, 10) });
    } catch (error) {
      patch(provider, { note: error instanceof Error ? error.message : "تعذّر رفع الملف." });
    } finally {
      setUploadingFor(null);
      uploadTarget.current = null;
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (isLoading || !base) return null;

  return (
    <div className="mt-4">
      <div className="post-card-grid">
        {targets.map((provider) => {
          const card = cards[provider];
          if (!card) return null;
          const isConnected = connected.includes(provider);
          const long = card.text.length > 220;
          const open = expanded[provider] ?? false;
          const busy = card.status === "publishing" || card.status === "scheduling";
          const settled = card.status === "published" || card.status === "scheduled";
          return (
            <article key={provider} className="post-card" dir="auto">
              <header className="post-card-head">
                <span className="post-card-logo">
                  <AppIcon name={provider} className="size-6" />
                </span>
                <span className="post-card-name">{appLabel(provider)}</span>
                <button
                  type="button"
                  className="post-card-icon"
                  aria-label="عدّل النص"
                  title="عدّل النص"
                  onClick={() => setEditing((v) => (v === provider ? null : provider))}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  className="post-card-icon"
                  aria-label="جدولة"
                  title="جدولة"
                  onClick={() => setScheduling((v) => (v === provider ? null : provider))}
                >
                  <CalendarClock className="size-4" />
                </button>
                {isConnected ? (
                  <button
                    type="button"
                    className="post-card-publish"
                    disabled={busy || settled}
                    onClick={() => void act(provider, "now")}
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : settled ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                    {settled ? "تم" : "انشر"}
                  </button>
                ) : (
                  <ConnectNow
                    workspaceId={workspaceId}
                    provider={provider}
                    size="sm"
                    label={`اربط ${providerLabel(provider)}`}
                    className="post-card-publish is-connect"
                  />
                )}
              </header>

              {editing === provider ? (
                <div className="post-card-edit">
                  <textarea
                    value={card.text}
                    onChange={(event) => patch(provider, { text: event.target.value })}
                    dir="auto"
                    rows={Math.min(16, Math.max(5, card.text.split("\n").length + 2))}
                  />
                  <div className="post-card-edit-foot">
                    <span>{card.text.length.toLocaleString("en-US")} حرف</span>
                    <button type="button" onClick={() => setEditing(null)}>
                      <Check className="size-3.5" /> تم
                    </button>
                  </div>
                </div>
              ) : (
                <p className={cn("post-card-body", !open && long && "is-clamped")}>
                  {card.text}
                  {long ? (
                    <button
                      type="button"
                      onClick={() => setExpanded((p) => ({ ...p, [provider]: !open }))}
                    >
                      {open ? "أقل" : "المزيد"}
                    </button>
                  ) : null}
                </p>
              )}

              {card.media.length ? (
                <div className="post-card-media">
                  {card.media.map((m) => (
                    <span key={m.url}>
                      {m.kind === "image" ? (
                        <img src={m.url} alt="وسائط المنشور" loading="lazy" />
                      ) : (
                        <video src={m.url} controls preload="metadata" />
                      )}
                      <button
                        type="button"
                        aria-label="حذف الوسائط"
                        onClick={() =>
                          patch(provider, { media: card.media.filter((x) => x.url !== m.url) })
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <footer className="post-card-foot">
                <button
                  type="button"
                  onClick={() => pickFile(provider)}
                  disabled={uploadingFor === provider}
                >
                  {uploadingFor === provider ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ImagePlus className="size-3.5" />
                  )}
                  {card.media.length ? "أضف وسائط" : "أرفق صورة/فيديو"}
                </button>
                {card.note ? <small>{card.note}</small> : null}
              </footer>

              {scheduling === provider ? (
                <div className="post-card-schedule">
                  <input
                    type="datetime-local"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy || !isConnected}
                    onClick={() => void act(provider, "later")}
                  >
                    {card.status === "scheduling" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <CalendarClock className="size-3.5" />
                    )}
                    جدول
                  </button>
                  <button type="button" onClick={() => setScheduling(null)} aria-label="إغلاق">
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(event) => void onFiles(event.target.files)}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[0.7rem] font-bold hover:bg-secondary"
        >
          <SlidersHorizontal className="size-3.5" />
          {advanced ? "إخفاء الخيارات المتقدمة" : "خيارات متقدمة (مواعيد متعددة، جودة، توليد صور)"}
        </button>
      </div>

      {advanced ? (
        <PublishPanel
          workspaceId={workspaceId}
          employeeId={employeeId}
          taskId={taskId ?? null}
          channel={targets[0] ?? "instagram"}
          request={request ?? null}
          body={body}
        />
      ) : null}
    </div>
  );
}
