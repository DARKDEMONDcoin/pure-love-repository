/**
 * نواة طابور النشر الاجتماعي: تنشر المنشورات التي حان موعدها فعلياً على المنصة المربوطة.
 * تُستخدم من المشغّل المجدول (‎/api/public/social-queue‎) ومن زر «انشر الآن» بنفس المنطق.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { sanitizePostBody } from "./post-format";

type Admin = SupabaseClient<Database>;

/** أقصى عدد منشورات في التشغيل الواحد — سقف صريح يمنع أي تشغيل غير منتهٍ. */
const BATCH = 10;
/** أقصى عدد محاولات قبل اعتبار المنشور فاشلاً نهائياً. */
const MAX_ATTEMPTS = 3;
/** مدة الحجز: منشور محجوز أقدم من هذا يُعتبر عالقاً ويُعاد التقاطه. */
const LOCK_MS = 10 * 60 * 1000;

export type QueueReport = {
  id: string;
  provider: string;
  status: "published" | "retry" | "failed";
  error?: string;
};

/** يستخرج معرّف المنشور على المنصة من رد الـAPI حين يكون متاحاً. */
function remoteRef(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  for (const key of ["postId", "id", "post_id", "post_ids", "urn", "share_id", "permalink"]) {
    const value = obj[key];
    if (typeof value === "string" && value) return value.slice(0, 200);
  }
  const nested = obj["ret"] ?? obj["data"] ?? obj["exports"];
  if (nested && nested !== result) return remoteRef(nested);
  return null;
}

function videoOf(meta: unknown): string | null {
  const v = meta && typeof meta === "object" ? (meta as { videoUrl?: unknown }).videoUrl : null;
  return typeof v === "string" && /^https?:\/\//.test(v) ? v : null;
}

/** الوسائط المتعددة المحفوظة مع المنشور (ألبوم/كاروسيل). */
function mediaOf(meta: unknown): { url: string; kind: "image" | "video" }[] {
  const raw = meta && typeof meta === "object" ? (meta as { media?: unknown }).media : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    if (!m || typeof m !== "object") return [];
    const { url, kind } = m as { url?: unknown; kind?: unknown };
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return [];
    return [{ url, kind: kind === "video" ? ("video" as const) : ("image" as const) }];
  });
}


/** ينشر منشوراً واحداً ويحدّث صفّه — يُستدعى من الطابور ومن النشر الفوري. */
export async function publishQueuedPost(admin: Admin, id: string): Promise<QueueReport> {
  const { data: post, error } = await admin
    .from("social_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!post) throw new Error("المنشور غير موجود.");

  const attempts = (post.attempts ?? 0) + 1;
  const videoUrl = videoOf(post.meta);
  const media = mediaOf(post.meta);

  try {
    const { publishToPlatform } = await import("./pipedream-publish.server");
    const published = await publishToPlatform(admin, {
      workspaceId: post.workspace_id,
      provider: post.provider,
      text: sanitizePostBody(post.body) || post.body,
      ...(post.image_url ? { imageUrl: post.image_url } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      ...(media.length ? { media } : {}),
    });


    await admin
      .from("social_posts")
      .update({
        status: "published",
        attempts,
        locked_at: null,
        published_at: new Date().toISOString(),
        remote_ref: remoteRef(published.result),
        last_error: null,
      })
      .eq("id", post.id);

    if (post.task_id) {
      await admin.from("tasks").update({ status: "done" }).eq("id", post.task_id);
    }

    return { id: post.id, provider: post.provider, status: "published" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "فشل غير معروف";
    const exhausted = attempts >= MAX_ATTEMPTS;
    await admin
      .from("social_posts")
      .update({
        status: exhausted ? "failed" : "scheduled",
        attempts,
        locked_at: null,
        scheduled_at: exhausted
          ? post.scheduled_at
          : new Date(Date.now() + attempts * 2 * 60 * 1000).toISOString(),
        last_error: message.slice(0, 500),
      })
      .eq("id", post.id);
    return {
      id: post.id,
      provider: post.provider,
      status: exhausted ? "failed" : "retry",
      error: message.slice(0, 500),
    };
  }
}

/**
 * يلتقط دفعة محدودة من المنشورات المستحقة وينشرها.
 * الحجز (locked_at) يمنع تشغيلين متوازيين من نشر نفس المنشور مرتين.
 */
export async function runDueSocialPosts(admin: Admin, now = new Date()): Promise<QueueReport[]> {
  const staleBefore = new Date(now.getTime() - LOCK_MS).toISOString();

  const { data: due, error } = await admin
    .from("social_posts")
    .select("id, locked_at")
    .eq("status", "scheduled")
    .lte("scheduled_at", now.toISOString())
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(error.message);
  if (!due?.length) return [];

  const report: QueueReport[] = [];
  for (const row of due) {
    // حجز ذرّي: التحديث ينجح لمرة واحدة فقط لأن الشرط يتضمن الحجز السابق.
    const { data: claimed } = await admin
      .from("social_posts")
      .update({ locked_at: now.toISOString() })
      .eq("id", row.id)
      .eq("status", "scheduled")
      .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
      .select("id");
    if (!claimed?.length) continue;

    try {
      report.push(await publishQueuedPost(admin, row.id));
    } catch (e) {
      const message = e instanceof Error ? e.message : "فشل غير معروف";
      await admin
        .from("social_posts")
        .update({ locked_at: null, last_error: message.slice(0, 500) })
        .eq("id", row.id);
      report.push({ id: row.id, provider: "—", status: "retry", error: message.slice(0, 500) });
    }
  }
  return report;
}
