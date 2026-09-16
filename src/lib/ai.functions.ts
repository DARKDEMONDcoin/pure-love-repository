import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { freeChat } from "@/lib/nour-research.server";
import { actionTruthRules, sanitizeActionClaims } from "@/lib/action-claims";
import { dedupeParagraphs } from "@/lib/post-format";
import {
  craft,
  evidenceRules,
  executeSkill,
  personas,
  qualityCriteria,
  researchFor,
} from "@/lib/nour-run.server";
import { employeeDirectory, sharedSystemBlocks, type EmployeeId } from "@/lib/team-knowledge";
import { employeeEdgeBlock } from "@/lib/employee-edge";
import { playbookFor } from "@/lib/playbooks";

type Deliverable = {
  title?: string;
  kind?: string;
  channel?: string;
  body?: string;
  scheduled?: string;
  image_prompt?: string | null;
};

type NeedsConnection = { provider: string; reason: string } | null;

/** ترجمة مفاتيح JSON الشائعة إلى عناوين عربية عند عرض مخرج غير مطابق للبنية. */
const KEY_LABELS: Record<string, string> = {
  day: "اليوم",
  date: "التاريخ",
  title: "العنوان",
  content_pillar: "محور المحتوى",
  pillar: "المحور",
  channel: "المنصة",
  platform: "المنصة",
  body: "النص",
  caption: "النص",
  text: "النص",
  hashtags: "الهاشتاجات",
  scheduled: "موعد النشر",
  best_time: "أفضل وقت",
  time: "الوقت",
  metrics_to_measure: "مؤشرات القياس",
  metrics: "المؤشرات",
  kpis: "المؤشرات",
  call_to_action: "دعوة لاتخاذ إجراء",
  cta: "دعوة لاتخاذ إجراء",
  instagram_post: "منشور إنستجرام",
  x_post: "تغريدة إكس",
  linkedin_post: "منشور لينكدإن",
  facebook_post: "منشور فيسبوك",
  notes: "ملاحظات",
  summary: "ملخص",
};

/** مفاتيح تقنية لا تُعرض للمستخدم داخل النص. */
const HIDDEN_KEYS = new Set(["image_prompt", "needs_connection", "kind", "provider", "reason"]);

const labelFor = (key: string) => KEY_LABELS[key] ?? key.replace(/_/g, " ");

/** يحوّل أي بنية JSON غير متوقعة إلى Markdown عربي مقروء بدل عرض JSON خام. */
function jsonToMarkdown(node: unknown, depth = 0): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node.replace(/\\n/g, "\n").trim();
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) {
    return node
      .map((item) => {
        const rendered = jsonToMarkdown(item, depth + 1);
        if (!rendered) return "";
        return typeof item === "object" && item !== null ? rendered : `- ${rendered}`;
      })
      .filter(Boolean)
      .join(depth === 0 ? "\n\n---\n\n" : "\n");
  }
  if (typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>).filter(
      ([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && v !== undefined && v !== "",
    );
    return entries
      .map(([key, value]) => {
        const rendered = jsonToMarkdown(value, depth + 1);
        if (!rendered) return "";
        const heading = "#".repeat(Math.min(depth + 2, 6));
        if (typeof value === "object") return `${heading} ${labelFor(key)}\n\n${rendered}`;
        if (rendered.includes("\n")) return `**${labelFor(key)}:**\n\n${rendered}`;
        return `**${labelFor(key)}:** ${rendered}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** يلتقط المخرجات الجاهزة من أي بنية JSON متداخلة (خطة أسبوع، عدة منشورات…). */
function harvestDeliverables(node: unknown, out: Deliverable[] = [], depth = 0): Deliverable[] {
  if (out.length >= 24 || depth > 5 || !node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) harvestDeliverables(item, out, depth + 1);
    return out;
  }
  const obj = node as Record<string, unknown>;
  const text = ["body", "caption", "text", "content", "post"]
    .map((k) => obj[k])
    .find((v): v is string => typeof v === "string" && v.trim().length > 30);
  if (text) {
    const extras = [obj["hashtags"], obj["call_to_action"], obj["cta"]]
      .map((v) => (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : ""))
      .filter(Boolean)
      .join("\n\n");
    const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
    const channel = str("channel") ?? str("platform");
    const scheduled = str("scheduled") ?? str("best_time");
    const imagePrompt = str("image_prompt");
    out.push({
      title: str("title") ?? str("day") ?? "مخرج جاهز",
      body: extras ? `${text.replace(/\\n/g, "\n")}\n\n${extras}` : text.replace(/\\n/g, "\n"),
      ...(channel ? { channel } : {}),
      ...(scheduled ? { scheduled } : {}),
      ...(imagePrompt ? { image_prompt: imagePrompt } : {}),
    });
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") harvestDeliverables(value, out, depth + 1);
  }
  return out;
}

export const askEmployeeInput = z.object({
  workspaceId: z.string().uuid(),
  employeeId: z.string().min(1),
  message: z.string().min(1).max(4000),
  conversationId: z.string().uuid(),
  /** وسائط أرفقها المستخدم (صور/فيديو) — تُحفظ داخل رسالته وتُعرض في المحادثة. */
  attachments: z
    .array(
      z.object({
        url: z.string().url().max(2000),
        type: z.enum(["image", "video"]).default("image"),
        alt: z.string().max(160).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** تحكّم المستخدم في الصورة التلقائية: تلقائي · إيقاف · وصف يكتبه بنفسه. */
  imageMode: z.enum(["auto", "off", "manual"]).optional(),
  imagePrompt: z.string().max(900).optional(),
  imageAspect: z.enum(["square", "portrait", "landscape", "story"]).optional(),
  /** طول المنشور المطلوب (اختياري) — «تلقائي» يترك القرار للموظف حسب المنصة. */
  postLength: z.enum(["auto", "short", "medium", "long"]).optional(),
});

/** الموظفون الذين تُولَّد لهم صورة فعلية عند وجود وصف بصري في الرد. */
const VISUAL_EMPLOYEES = new Set(["dana", "sonny", "nour"]);

/** حدث تقدّم حقيقي يُبثّ للمستخدم أثناء تنفيذ الطلب. */
export type TurnEvent =
  | { type: "step"; label: string }
  | { type: "delta"; text: string }
  | { type: "reset" };

export type TurnEmit = (event: TurnEvent) => void;

/** مستقبل أحداث صامت: المسار العادي بلا بثّ. */
const noEmit: TurnEmit = () => {};
export type AskEmployeeInput = z.infer<typeof askEmployeeInput>;
export type TurnContext = { supabase: SupabaseClient<Database> };

export const askEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => askEmployeeInput.parse(data))
  .handler(async ({ data, context }) =>
    runEmployeeTurn(data, context as unknown as TurnContext, noEmit),
  );

/**
 * دورة عمل الموظف الكاملة. تُستخدم من الشات العادي (بلا بثّ)
 * ومن مسار البثّ الحقيقي (emit يسلّم مراحل التنفيذ والنص وهو يُكتب).
 */
export async function runEmployeeTurn(
  data: AskEmployeeInput,
  context: TurnContext,
  emit: TurnEmit = noEmit,
) {
  {
    // المفاتيح تُقرأ داخل freeChat من جدول app_secrets في Supabase.
    const apiKey = "";

    const supabase = context.supabase;
    const persona = personas[data.employeeId];
    if (!persona) throw new Error("موظف غير معروف.");

    const [
      { data: workspace },
      { data: conversation },
      { data: brain },
      { data: durable },
      { data: history },
      { data: linked },
      { data: direct },
      { data: recentTasks },
    ] = await Promise.all([
      supabase.from("workspaces").select("*").eq("id", data.workspaceId).maybeSingle(),
      supabase
        .from("conversations")
        .select("id, title")
        .eq("id", data.conversationId)
        .eq("workspace_id", data.workspaceId)
        .eq("employee_id", data.employeeId)
        .maybeSingle(),
      supabase.from("brain_items").select("title, body, kind").eq("workspace_id", data.workspaceId),
      supabase
        .from("brand_memories")
        .select("content, kind")
        .eq("workspace_id", data.workspaceId)
        .is("superseded_by", null)
        .or(`valid_until.is.null,valid_until.gt.${new Date().toISOString()}`)
        .order("updated_at", { ascending: false })
        .limit(80),
      supabase
        .from("messages")
        .select("role, body")
        .eq("workspace_id", data.workspaceId)
        .eq("employee_id", data.employeeId)
        .eq("conversation_id", data.conversationId)
        .order("created_at", { ascending: false })
        .limit(12),
      supabase
        .from("pipedream_accounts")
        .select("provider")
        .eq("workspace_id", data.workspaceId)
        .eq("status", "connected"),
      supabase
        .from("integrations")
        .select("provider")
        .eq("workspace_id", data.workspaceId)
        .eq("status", "connected"),
      // ما أنجزه الزملاء مؤخراً — حتى يعرف كل موظف ما يجري في الفريق.
      supabase
        .from("tasks")
        .select("employee_id, title, status, created_at")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

    // حالة الربط الحقيقية تُحقن في التعليمات حتى لا يدّعي الموظف نشراً مستحيلاً.
    const connected = [
      ...new Set([
        ...(linked ?? []).map((a) => a.provider),
        ...(direct ?? []).map((i) => i.provider),
      ]),
    ];

    if (!workspace) throw new Error("مساحة العمل غير موجودة.");
    if (!conversation) throw new Error("المحادثة غير موجودة.");
    const ws = workspace as typeof workspace & {
      profile?: unknown;
      website?: string | null;
      country?: string | null;
    };

    // وسائط المستخدم تُحفظ داخل نص رسالته لتظهر في المحادثة وتبقى في السجل.
    const attachments = data.attachments ?? [];
    const attachmentsMarkdown = attachments
      .map((a) =>
        a.type === "video"
          ? `\n\n🎬 [${a.alt ?? "فيديو مرفق"}](${a.url})`
          : `\n\n![${a.alt ?? "صورة مرفقة"}](${a.url})`,
      )
      .join("");

    const { data: userRow, error: insertUserError } = await supabase
      .from("messages")
      .insert({
        workspace_id: data.workspaceId,
        employee_id: data.employeeId,
        role: "user",
        body: `${data.message}${attachmentsMarkdown}`,
        conversation_id: data.conversationId,
      })
      .select("id")
      .single();

    if (insertUserError) throw new Error(insertUserError.message);

    const { coworkerVoiceBlock, shortTopic } = await import("./coworker-voice");
    const turnTopic = shortTopic(data.message);
    emit({
      type: "step",
      label: (history ?? []).length
        ? `رجعت لآخر ما اتفقنا عليه وقرأت طلبك عن «${turnTopic}»`
        : `قرأت طلبك عن «${turnTopic}» وذاكرة علامتك`,
    });

    const { durableMemoryItems, extractExplicitMemories, memoryBlock } =
      await import("./memory.server");
    const brainText = memoryBlock(
      [...(brain ?? []), ...durableMemoryItems(durable ?? [])],
      data.message,
      10,
    );
    const extracted = extractExplicitMemories(data.message);
    if (extracted.length) {
      await supabase.from("brand_memories").insert(
        extracted.map((item) => ({
          workspace_id: data.workspaceId,
          conversation_id: data.conversationId,
          employee_id: data.employeeId,
          source_message_id: userRow?.id ?? null,
          kind: item.kind,
          content: item.content,
          confidence: 1,
        })),
      );
    }
    if (conversation.title === "محادثة جديدة") {
      const cleanTitle = data.message
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[\n\r]+/g, " ")
        .replace(/^[\s،,:؛.!؟-]+|[\s،,:؛.!؟-]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      await supabase
        .from("conversations")
        .update({
          title: cleanTitle.slice(0, 55) || "محادثة جديدة",
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.conversationId);
    } else {
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", data.conversationId);
    }

    const longForm =
      /مقال|خطة\s*(سيو|محتوى|تسويق)|\d{3,4}\s*كلمة|صفحة هبوط|دليل شامل|حملة كاملة/.test(
        data.message,
      ) || data.message.length > 220;

    // نيّة الرسالة: عمل (مخرج جاهز) أم سؤال/دردشة يُجاب عليها فقط بلا فرض خدمات.
    const { chatIntent, intentBlock, wantsImageRequest } = await import("./chat-intent");
    const intent = chatIntent(data.message);
    /** طلب صورة صريح من المستخدم: تُولَّد صورة فعلية أياً كان الموظف. */
    const explicitImage = intent === "work" && wantsImageRequest(data.message);
    /** البثّ الحقيقي للطلبات الصريحة فقط — الأسئلة والدردشة تُجاب فوراً بلا بثّ. */
    const streaming = emit !== noEmit && intent === "work";
    // عقل الخبير: عمق التخصص + سؤال واحد بخيارات عند الغموض الجوهري فقط.
    const { expertMindBlock } = await import("./expert-mind");

    // الوعي اللحظي: الزمن الدقيق دائماً + بحث حيّ عن الأحداث الجارية عند الحاجة.
    const { nowBlock, needsLiveFacts, liveFactsBlock } = await import("./live-context.server");
    const timezone =
      (workspace as { timezone?: string | null }).timezone ??
      (ws.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo");

    emit({ type: "step", label: `أجمع أدلة وأرقاماً حقيقية عن «${turnTopic}»` });
    const [research, liveBlock] = await Promise.all([
      researchFor(
        data.employeeId,
        apiKey,
        { name: workspace.name, industry: workspace.industry },
        data.message,
        data.workspaceId,
        // الطلبات الكبيرة تستحق أدلة أكمل (مقاييس + نتائج بحث + موجز منافسين).
        longForm ? 22_000 : 12_000,
      ),
      needsLiveFacts(data.message)
        ? liveFactsBlock(data.message).catch(() => "")
        : Promise.resolve(""),
    ]);

    // المنصة التي سمّاها المستخدم بنفسه — تُحترم حرفياً ولا تُبدَّل بغيرها.
    const { requestedPublishTargets, providerLabel } = await import("./platforms");
    const askedTargets = requestedPublishTargets(data.message);
    const askedBlock = askedTargets.length
      ? `## المنصة التي طلبها المستخدم صراحةً\nالمستخدم طلب: ${askedTargets.map((p) => `${providerLabel(p)} (${p})`).join("، ")}. ` +
        `اجعل "channel" في المخرج هو "${askedTargets[0]}" حرفياً، وكيّف النص لقواعد هذه المنصة (الطول، النبرة، الهاشتاقات). ` +
        `لا تقترح منصة أخرى بدلاً منها. ` +
        (askedTargets.some((p) => !connected.includes(p))
          ? `تنبيه: ${askedTargets
              .filter((p) => !connected.includes(p))
              .map(providerLabel)
              .join(
                " و",
              )} غير مربوط بعد — أنجز المخرج كاملاً، وضع في needs_connection المنصة "${askedTargets.find((p) => !connected.includes(p))}" بسبب قصير.`
          : `هذه المنصة مربوطة — أنجز المخرج جاهزاً للنشر عليها مباشرة.`)
      : "";

    // تنفيذ فعلي لقدرات الأقسام من داخل الشات (فحص سيو، ترتيب، تقويم، أفكار، أداء).
    emit({ type: "step", label: "أفتح أدوات المنصة وأشغّل الفحص والتحليل بنفسي" });
    let toolBlocks: { block: string; footer: string; tool: string }[] = [];
    try {
      const { runChatTools } = await import("./chat-tools.server");
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      toolBlocks = await runChatTools(supabaseAdmin, {
        workspaceId: data.workspaceId,
        employeeId: data.employeeId,
        message: data.message,
        website: ws.website,
        country: ws.country,
        connected,
        targets: askedTargets,
        industry: workspace.industry,
        brand: workspace.name,
      });
    } catch (e) {
      console.warn("[chat-tools] skipped:", e instanceof Error ? e.message : e);
    }
    if (toolBlocks.length) {
      emit({
        type: "step",
        label: `خلصت: ${toolBlocks.map((t) => t.tool).slice(0, 3).join("، ")}`,
      });
    }
    const toolsBlock = toolBlocks.length
      ? `## نتائج نفّذتها فعلاً الآن من أقسام المنصة (حقيقية — استخدمها حرفياً)\n${toolBlocks.map((t) => t.block).join("\n\n")}`
      : "";

    const teamActivity = (recentTasks ?? [])
      .map((t) => {
        const who = employeeDirectory[t.employee_id as EmployeeId]?.name ?? t.employee_id;
        return `- ${who}: ${t.title} (${t.status === "done" ? "منشور/منجز" : t.status === "review" ? "بانتظار الاعتماد" : t.status})`;
      })
      .join("\n");

    // صاحب العمل: اسمه الأول ومسمّاه — حتى يخاطبه الموظف كزميل يعرفه لا كمستخدم مجهول.
    const { data: ownerProfile } = await supabase
      .from("profiles")
      .select("full_name, job_title")
      .eq("id", workspace.owner_id)
      .maybeSingle();
    const ownerFirstName =
      (ownerProfile?.full_name ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? null;

    // «اليوم الأول»: هل تحدّث معه هذا الموظف من قبل إطلاقاً في هذه المساحة؟
    let firstEverTurn = false;
    if ((history ?? []).length === 0) {
      const { count: priorCount } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", data.workspaceId)
        .eq("employee_id", data.employeeId)
        .eq("role", "assistant");
      firstEverTurn = (priorCount ?? 0) === 0;
    }

    // ذاكرة سِراج التشغيلية: صوت العلامة + قواعد مستخلصة من أداء الحساب + المجدول القادم.
    let sirajMemory = "";
    if (data.employeeId === "sonny") {
      try {
        const { sirajContext } = await import("./siraj-context.server");
        sirajMemory = await sirajContext(supabase as never, data.workspaceId);
      } catch (error) {
        console.error("[siraj] operational context failed:", error);
      }
    }

    // ذاكرة نور التشغيلية: أرقام Search Console الحقيقية + الكلمات المتتبَّعة + ما نشرته + قنوات النشر.
    // ذاكرة القرارات: ما اتفقتم عليه سابقاً يُحقن دائماً كي لا يتناقض الموظف مع نفسه.
    let decisionsMemory = "";
    try {
      const { decisionsBlock } = await import("./decisions.server");
      decisionsMemory = await decisionsBlock(supabase as never, data.workspaceId, data.message, 6);
    } catch (error) {
      console.error("[decisions] context failed:", error);
    }

    let nourMemory = "";
    if (data.employeeId === "nour") {
      try {
        const { nourContext } = await import("./nour-context.server");
        nourMemory = await nourContext(supabase as never, data.workspaceId);
      } catch (error) {
        console.error("[nour] operational context failed:", error);
      }
    }

    const system = [
      `أنت ${persona.name}، ${persona.role}`,
      `تعمل داخل منصة «سهل» لصالح العلامة: ${workspace.name} (${workspace.industry}).`,
      `نبرة العلامة: ${workspace.tone}.`,
      nowBlock(timezone),
      liveBlock,
      intentBlock(intent),
      coworkerVoiceBlock({
        employeeId: data.employeeId,
        firstEver: firstEverTurn,
        employeeName: persona.name,
        role: persona.role,
        userName: ownerFirstName,
        userTitle: ownerProfile?.job_title ?? null,
        intent,
        firstMessage: (history ?? []).length === 0,
        teamActivity,
      }),
      expertMindBlock(data.employeeId, intent),
      intent === "work" ? employeeEdgeBlock(data.employeeId) : "",
      workspace.banned_words?.length
        ? `كلمات ممنوعة تماماً: ${workspace.banned_words.join("، ")}.`
        : "",
      craft[data.employeeId] ? `## معايير حِرفتك\n${craft[data.employeeId]}` : "",
      playbookFor(data.employeeId, data.message),
      sirajMemory,
      nourMemory,
      decisionsMemory,
      qualityCriteria[data.employeeId]?.length
        ? `## معايير قبول الرد\n${(qualityCriteria[data.employeeId] ?? []).map((criterion, index) => `${index + 1}) ${criterion}`).join("\n")}`
        : "",
      ...sharedSystemBlocks({
        employeeId: data.employeeId,
        connected,
        profile: ws.profile,
        website: ws.website,
        country: ws.country,
      }),
      brainText ? `## عقل العلامة (ذاكرة مشتركة بين الفريق)\n${brainText}` : "",
      teamActivity ? `## آخر ما أنجزه الفريق\n${teamActivity}` : "",
      research.block ? `${evidenceRules}\n\n## أدلة ميدانية (لحظية)\n${research.block}` : "",
      actionTruthRules,
      askedBlock,
      toolsBlock,
      "## أسلوب المحادثة",
      "فكّر داخلياً بالترتيب: افهم الهدف، تحقق من الأدلة، اختر الإجراء، ثم سلّم النتيجة. لا تعرض خطوات تفكيرك.",
      "راجع الإجابة قبل تسليمها: الدقة، الاكتمال، ملاءمة السوق العربي، صدق ما تم تنفيذه، وخطوة تالية واحدة.",
      "أجب دائماً بالعربية. التحية والأسئلة القصيرة: رد قصير ودافئ بجملة أو اثنتين ثم اقتراح عملي واحد. طلبات العمل: مخرج كامل جاهز مباشرة.",
      "## تنسيق الرد (إلزامي)",
      "ابدأ بسطر خلاصة واحد يقول النتيجة أو الرقم الأهم بخط عريض، ثم التفاصيل تحته.",
      "استخدم عناوين `###` قصيرة لكل محور، وقوائم نقطية من سطر واحد لكل نقطة، وأبرز الأرقام والكلمات المفتاحية بخط عريض.",
      "الفقرة لا تتجاوز ثلاثة أسطر. لا تكرر نفس المعلومة في أكثر من مكان، ولا تكتب مقدمات إنشائية ولا اعتذارات.",
      "البيانات المقارنة (كلمات بحث، منافسون، صفحات، أرقام أداء) تُعرض في جدول Markdown بأعمدة واضحة لا كقائمة طويلة.",
      intent === "work"
        ? "اختم بقسم `### الخطوة التالية` فيه إجراء واحد محدد قابل للتنفيذ اليوم."
        : "لا تضف قسم «الخطوة التالية» ولا اقتراحات خدمات في هذا الرد.",
      "ممنوع في الرد: JSON أو أقواس تقنية أو أسماء أدوات داخلية أو روابط خام مكررة أو نص إنجليزي غير ضروري أو رموز تعبيرية أكثر من واحد في القسم.",
      data.employeeId === "nour"
        ? "## بنية رد نور\nلطلبات السيو والمحتوى رتّب الرد هكذا: **الخلاصة** ← `### الوضع الحالي` (أرقام الفحص) ← `### الفرص` (جدول كلمات/صفحات مع الحجم والصعوبة والنية) ← `### المنافسون` (ما يفعلونه وما ينقصك) ← `### خطة التنفيذ` (مرتبة بالأثر لا بالترتيب الزمني فقط) ← `### الخطوة التالية`. اذكر مصدر كل رقم بإيجاز (فحص الموقع / بحث الكلمات / Search Console)، وإن غاب مصدر قل ذلك بصراحة في سطر واحد بدل تخمين الأرقام."
        : "",
      data.employeeId === "sonny" && intent === "work"
        ? "## بنية رد سِراج\nلطلبات المحتوى والنشر رتّب الرد هكذا: **الخلاصة** (الزاوية والهدف في سطر) ← `### المنشور` (النص الجاهز حرفياً كما يُنشر، بلا شرح داخله) ← `### الهاشتاقات` (بطبقات) ← `### الصورة/الفيديو` (سطر واحد عربي عمّا سيظهر + سطر «نص بديل:» يصف الصورة، والوصف الإنجليزي في image_prompt فقط) ← `### التوقيت والقياس` (وقت النشر بتوقيت الجمهور + مؤشر واحد يُقاس بعد 48 ساعة) ← `### الخطوة التالية`. لخطة أو عدة منشورات: جدول Markdown (اليوم | المنصة | الزاوية | نوع المخرج | وقت النشر) ثم النصوص الكاملة في المخرجات. أضف `### تنبيه` بسطر واحد فقط عند وجود خطر فعلي (ادعاء غير موثّق طلبه المستخدم، مجال حسّاس، أزمة، محتوى مدفوع بلا إفصاح، افتراض جوهري بنيت عليه)."
        : "",
      data.employeeId === "sonny"
        ? "افترض ما ينقص افتراضاً مهنياً ونفّذ فوراً؛ لا تسأل أكثر من سؤال واحد ولا تؤجّل المخرج بسبب معلومة ناقصة."
        : "",

      intent === "work"
        ? "إن كان طلب المستخدم يحتاج صورة (تصميم، منشور بصري، صورة مقال، كرييتف) فاكتب وصفاً بصرياً إنجليزياً دقيقاً في الحقل image_prompt — وستُولَّد الصورة فعلياً وتُعرض للمستخدم؛ لا تكتفِ بوصفها في النص."
        : "",
      explicitImage
        ? [
            "## طلب صورة صريح (إلزامي في هذه الرسالة)",
            "المستخدم طلب صورة/تصميماً فعلياً. الصورة **ستُولَّد وتُعرض له تحت ردك تلقائياً** من الحقل image_prompt.",
            "اكتب في image_prompt وصفاً إنجليزياً واحداً غنياً وقابلاً للتنفيذ (الموضوع، الأسلوب، التكوين، الإضاءة، الألوان، الخلفية، نسبة الأبعاد، وأي نص يظهر داخل الصورة إن طلبه) بما يطابق طلبه ونبرة العلامة.",
            "ردّك النصي يبقى قصيراً: سطر يقول ما الذي صُمِّم ولماذا هذه الزاوية، وسطر «نص بديل:» بالعربية. ممنوع تماماً أن تكتب للمستخدم أنك «لا تستطيع توليد الصور» أو أن تعطيه البرومبت الإنجليزي في النص أو أن تصف الصورة في فقرات طويلة بدل توليدها.",
            'إن لم يكن هناك منشور مطلوب فاجعل "deliverable" هكذا: {"title": "عنوان الصورة", "kind": "صورة", "channel": null, "body": "سطر عربي واحد يصف ما تظهره الصورة", "scheduled": null, "image_prompt": "…English prompt…"}.',
          ].join("\n")
        : "",
      'أعد ردك بصيغة JSON فقط بالشكل: {"reply": "نص ردك للمستخدم بصيغة Markdown", "deliverable": {"title": "عنوان المخرج", "kind": "نوع المخرج", "channel": "المنصة", "body": "نص المخرج الجاهز", "scheduled": "متى يُنفّذ", "image_prompt": "English visual prompt or null"} , "needs_connection": {"provider": "معرّف المنصة مثل instagram أو wordpress أو search-console", "reason": "سبب من 8 كلمات مرتبط بهذه المهمة"} }',
      'ممنوع تماماً ابتكار بنية JSON أخرى. إن طلب المستخدم عدة مخرجات (خطة أسبوع، عدة منشورات، عدة منصات) فاستخدم مصفوفة "deliverables": [ {نفس حقول deliverable}, … ] بدل deliverable، واجعل "reply" ملخصاً بالعربية للخطة (المحاور، التوزيع، مؤشرات القياس) — ولا تضع JSON داخل reply أو داخل body إطلاقاً.',
      "قاعدة إلزامية للخطط: عنصر واحد في deliverables لكل منشور فعلي (يوم × منصة). خطة 3 أيام على 3 منصات = 9 عناصر، لكل عنصر channel صحيح (instagram / linkedin / x) وtitle يذكر اليوم والمنصة وbody يحتوي نص ذلك المنشور وحده مع هاشتاجاته وscheduled بأفضل وقت نشر. ممنوع وضع ملخص الخطة داخل body أو الاكتفاء بمخرج واحد.",
      "حقل body يجب أن يكون نص المنشور/المقال الجاهز للنشر كما يقرأه الجمهور فقط — بلا مفاتيح ولا أقواس ولا وصف الصورة. ووصف الصورة الإنجليزي يوضع في image_prompt وحده ولا يظهر للمستخدم.",
      'إن لم يطلب المستخدم مخرجاً جاهزاً للنشر أو الإرسال، اجعل "deliverable" القيمة null. واجعل "needs_connection" القيمة null إلا إذا كانت هذه المهمة تحديداً تحتاج حساباً غير مربوط لتنفيذها فعلياً (نشر/إرسال/قراءة بيانات حقيقية).',
      `المنصة الافتراضية لك هي ${persona.channel} ونوع مخرجك الشائع ${persona.kind}.`,
    ]
      .filter(Boolean)
      .join("\n");

    const priorMessages = (history ?? [])
      .slice()
      .reverse()
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.body }));

    // قراءة فعلية لوسائط المستخدم: نصف الصور بنموذج بصري ليعتمد الموظف على محتواها.
    let mediaRead = "";
    if (attachments.length) {
      try {
        const { describeUserMedia } = await import("./media-vision.server");
        mediaRead = await describeUserMedia(attachments);
      } catch {
        mediaRead = "";
      }
    }

    // نُعلم الموظف بوسائط المستخدم وبقراره حول الصورة حتى يبني عليها بدل تجاهلها.
    const mediaNote = [
      attachments.length
        ? `(المستخدم أرفق ${attachments.filter((a) => a.type === "image").length} صورة و${attachments.filter((a) => a.type === "video").length} فيديو مع الطلب — اعتمدها كوسائط المنشور ولا تطلب غيرها.)`
        : "",
      mediaRead
        ? `(محتوى وسائط المستخدم كما قرأها النظام — اعتمد عليه في ردك وحلّله إن سُئلت عنه: ${mediaRead.slice(0, 2000)})`
        : "",
      data.imageMode === "off" ? "(المستخدم أوقف توليد الصور — لا تكتب image_prompt.)" : "",
      data.imageMode === "manual" && data.imagePrompt
        ? `(المستخدم كتب وصف الصورة بنفسه: ${data.imagePrompt.slice(0, 300)} — لا تغيّره.)`
        : "",
      data.postLength && data.postLength !== "auto"
        ? `(طول المنشور المطلوب: ${
            data.postLength === "short"
              ? "قصير جداً ٣٠–٦٠ كلمة"
              : data.postLength === "medium"
                ? "متوسط ٨٠–١٢٠ كلمة"
                : "مطوّل ١٥٠–٢٢٠ كلمة"
          } — التزم بهذا المدى ولا تتجاوزه.)`
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    const userTurn = mediaNote ? `${data.message}\n\n${mediaNote}` : data.message;

    // خطة ضخمة (عدة أيام × عدة منصات): تُولَّد على دفعات — نداء واحد ضخم يتجاوز مهلة المزوّد.
    let campaign: { reply: string; deliverables: Record<string, unknown>[] } | null = null;
    if (askedTargets.length >= 2) {
      try {
        const { isCampaignRequest, generateCampaign } = await import("./campaign-plan.server");
        if (isCampaignRequest(data.message, askedTargets)) {
          campaign = await generateCampaign(apiKey, system, data.message, askedTargets);
        }
      } catch (error) {
        console.warn("[campaign] failed:", error instanceof Error ? error.message : error);
      }
    }

    // مقال طويل: يُكتب على مراحل — نص المقال داخل JSON واحد يُقتطع فيضيع المقال كله.
    if (!campaign && longForm) {
      try {
        const { isLongArticleRequest, generateLongArticle } = await import("./longform.server");
        if (isLongArticleRequest(data.message)) {
          const article = await generateLongArticle(apiKey, system, data.message);
          if (article) {
            campaign = {
              reply: `جهّزت لك المقال كاملاً: **${article.title}** — نصه الكامل بالأسفل، ومعه الميتا والأسئلة الشائعة وسكيما FAQ جاهزة.`,
              deliverables: [
                { title: article.title, kind: "مقال", channel: "wordpress", body: article.body },
              ],
            };
          }
        }
      } catch (error) {
        console.warn("[longform] failed:", error instanceof Error ? error.message : error);
      }
    }

    emit({ type: "step", label: "أكتب المخرج الآن كلمة بكلمة" });

    const chatMessages = [
      { role: "system", content: system },
      ...priorMessages,
      { role: "user", content: userTurn },
    ];
    // طلبات المقالات/الخطط الكاملة تحتاج مخرجاً طويلاً ومهلة أطول — مع سقف زمني إجمالي حتى لا يعلّق الشات.
    const chatOptions = longForm
      ? { json: true, timeoutMs: 75_000, maxTokens: 6000, budgetMs: 130_000 }
      : { json: true, timeoutMs: 40_000, maxTokens: 1800, budgetMs: 100_000 };

    let raw: string;
    if (campaign) {
      raw = JSON.stringify({ reply: campaign.reply, deliverables: campaign.deliverables });
    } else if (streaming) {
      // بثّ حقيقي: نص الرد يُسلَّم للمستخدم وهو يُكتب فعلياً من النموذج.
      const { freeChatStream } = await import("./nour-research.server");
      const { createReplyStreamer } = await import("./stream-reply");
      const streamer = createReplyStreamer((text) => emit({ type: "delta", text }));
      raw = await freeChatStream(apiKey, chatMessages, chatOptions, {
        onDelta: (chunk) => streamer.push(chunk),
        onRestart: () => {
          streamer.reset();
          emit({ type: "reset" });
        },
      });
    } else {
      raw = await freeChat(apiKey, chatMessages, chatOptions);
    }

    let reply = raw;
    let deliverables: Deliverable[] = [];
    let needsConnection: NeedsConnection = null;

    // محاولة إصلاح واحدة فقط للمخرجات الطويلة التي لم تُرجع JSON صالحاً أو مخرجاً كاملاً.
    if (longForm && (!raw.trim().startsWith("{") || !/"reply"\s*:/.test(raw))) {
      try {
        raw = await freeChat(
          apiKey,
          [
            { role: "system", content: system },
            { role: "user", content: data.message },
            { role: "assistant", content: raw },
            {
              role: "user",
              content:
                "راجع المسودة مرة واحدة وفق معايير القبول، وأصلح النقص أو القطع فقط. أعد JSON صالحاً كاملاً بنفس البنية المطلوبة دون شرح خارجي.",
            },
          ],
          { json: true, timeoutMs: 40_000, maxTokens: 6000, budgetMs: 55_000 },
        );
      } catch (error) {
        console.warn("[chat] repair pass skipped:", error instanceof Error ? error.message : error);
      }
    }

    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      const parsed: unknown = JSON.parse(cleaned);
      // النموذج قد يعيد كائناً واحداً أو مصفوفة كائنات — نتعامل مع الحالتين.
      const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        (
          x,
        ): x is {
          reply?: string;
          deliverable?: Deliverable | null;
          deliverables?: Deliverable[] | null;
          needs_connection?: NeedsConnection;
        } => Boolean(x) && typeof x === "object",
      );
      const replies = items
        .map((x) => (typeof x.reply === "string" ? x.reply.trim() : ""))
        .filter(Boolean);
      deliverables = items
        .flatMap((x) => [x.deliverable, ...(Array.isArray(x.deliverables) ? x.deliverables : [])])
        .filter((d): d is Deliverable => Boolean(d?.title && d.body))
        // لا نفرض المنصة إلا على مخرج بلا منصة، حتى لا تُدمج خطة متعددة المنصات في منصة واحدة.
        .map((d) => (d.channel ? d : askedTargets[0] ? { ...d, channel: askedTargets[0] } : d));
      // النموذج قد يعيد بنية خاصة به (خطة أسبوع، عدة منشورات) — نلتقط المخرجات منها بدل عرض JSON خام.
      if (!deliverables.length) deliverables = harvestDeliverables(parsed).slice(0, 14);
      const nc = items
        .map((x) => x.needs_connection)
        .find((n) => n && typeof n === "object" && typeof n.provider === "string");
      // لا نعرض زر ربط لحساب مربوط فعلاً أو لمنصة لا تخص هذا الموظف.
      if (nc && !connected.includes(nc.provider)) {
        const allowed = employeeDirectory[data.employeeId as EmployeeId]?.integrations.some(
          (i) => i.provider === nc.provider,
        );
        if (allowed)
          needsConnection = {
            provider: nc.provider,
            reason: String(nc.reason ?? "").slice(0, 160),
          };
      }
      // إن طلب المستخدم منصة غير مربوطة ولم يذكرها النموذج، نطلب ربطها نحن.
      const askedMissing = askedTargets.find((p) => !connected.includes(p));
      if (!needsConnection && askedMissing && deliverables.length) {
        needsConnection = {
          provider: askedMissing,
          reason: `طلبت النشر على ${providerLabel(askedMissing)}`,
        };
      }
      if (replies.length) {
        reply = replies.join("\n\n");
        // مخرج واحد طويل مع ردّ قصير: نعرض المخرج نفسه في المحادثة بدل تركه في المهام فقط.
        const only = deliverables.length === 1 ? deliverables[0] : null;
        if (only?.body && only.body.length > 400 && reply.length < only.body.length * 0.5) {
          reply = `${reply.trim()}\n\n### ${only.title}\n\n${only.body}`;
        }
      } else if (deliverables.length) {
        reply = deliverables.map((d) => `### ${d.title}\n\n${d.body}`).join("\n\n---\n\n");
      } else {
        // بنية غير متوقعة تماماً: نعرضها كنص عربي مقروء بدل JSON خام.
        const markdown = jsonToMarkdown(parsed);
        if (markdown.trim().length > 20) reply = markdown;
      }
    } catch {
      deliverables = [];
      // JSON مقطوع (ردّ طويل): ننقذ نص reply بدل عرض JSON خام للمستخدم.
      const m = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (m?.[1]) {
        try {
          reply = JSON.parse(`"${m[1]}"`);
        } catch {
          reply = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
        }
      }
    }

    // في المحادثة الحرة (سؤال/دردشة) لا مخرجات ولا طلبات ربط — إجابة فقط.
    if (intent !== "work") {
      deliverables = [];
      needsConnection = null;
    }

    // سِراج: فحص جودة حتمي لكل منشور (هوك، طول المنصة، دعوة، هاشتاقات، حشو، بقايا تنسيق)
    // وإعادة كتابة موجّهة لأي منشور ضعيف قبل عرضه — لا يخرج من سِراج نص دون المستوى.
    if (data.employeeId === "sonny" && deliverables.length) {
      try {
        const { autofixPosts } = await import("./post-autofix.server");
        const before = deliverables.map((d) => d.body ?? "");
        const fixed = (await autofixPosts(apiKey, deliverables as Record<string, unknown>[], {
          bannedWords: workspace.banned_words ?? [],
          dialect: workspace.tone,
          // وسائط حقيقية فقط: مرفقات المستخدم أو صورة ستُولَّد فعلاً.
          hasMedia: Boolean(data.attachments?.length) || (data.imageMode ?? "auto") !== "off",
        })) as typeof deliverables;

        // نُبقي نص المحادثة متطابقاً مع المخرج المحسّن بدل عرض نسختين مختلفتين.
        fixed.forEach((d, i) => {
          const old = before[i] ?? "";
          if (old && d.body && d.body !== old && reply.includes(old))
            reply = reply.replace(old, d.body);
        });
        deliverables = fixed;
      } catch (error) {
        console.warn("[chat] autofix skipped:", error instanceof Error ? error.message : error);
      }
    }

    // الصور تُولَّد فعلياً — لا يبقى المستخدم مع «برومبت» مكتوب فقط.
    // والمستخدم هو صاحب القرار: إيقاف · تلقائي · وصف يكتبه بنفسه (يُترجم حرفياً بلا إضافة).
    const imageMode = data.imageMode ?? "auto";
    const userImagePrompt = data.imagePrompt?.trim() ?? "";
    const wantsImage =
      imageMode === "manual"
        ? userImagePrompt.length > 2
        : imageMode !== "off" &&
          intent === "work" &&
          // طلب الصورة الصريح ينفّذه أي موظف؛ التوليد التلقائي يبقى للموظفين البصريين.
          (explicitImage || VISUAL_EMPLOYEES.has(data.employeeId)) &&
          attachments.every((a) => a.type !== "image");
    // توليد الصورة يبدأ الآن ويسير بالتوازي مع مراجعة الجودة — كانا متسلسلين فيضيفان
    // نحو دقيقة كاملة على كل رد بصري.
    const imageTask: Promise<string | null> = !wantsImage
      ? Promise.resolve(null)
      : (async (): Promise<string | null> => {
          let imageUrl: string | null = null;
          try {
        const { ownedHeroImage, extractImagePrompt, imageBrief, literalBrief, aspectSize } =
          await import("./image-gen.server");
        const fromField = deliverables
          .map((d) => d.image_prompt)
          .find((p) => typeof p === "string" && p.trim().length > 30);
        const draft =
          (fromField ? fromField.trim() : null) ??
          extractImagePrompt(`${reply}\n${deliverables.map((d) => d.body ?? "").join("\n")}`);
        const wantsVisual =
          imageMode === "manual" ||
          // طلب صريح للصورة: نولّدها دائماً حتى لو لم يُرجع النموذج وصفاً بصرياً.
          explicitImage ||
          Boolean(draft) ||
          deliverables.some((d) => d.body && d.body.length > 80);
        if (wantsVisual) {
          emit({ type: "step", label: "أولّد الصورة المطلوبة الآن" });
          // وصف المستخدم يُحترم حرفياً؛ وإلا يُشتق الوصف من طلبه ومن المخرج نفسه.
          const prompt =
            imageMode === "manual"
              ? await literalBrief(userImagePrompt)
              : await imageBrief({
                  request: data.message,
                  title: deliverables[0]?.title ?? null,
                  body: deliverables[0]?.body ?? reply,
                  brand: {
                    name: workspace?.name,
                    industry: workspace?.industry,
                    country: workspace?.country ?? null,
                  },
                  draft,
                });
          imageUrl = await ownedHeroImage(
            supabase as unknown as Parameters<typeof ownedHeroImage>[0],
            data.workspaceId,
            prompt,
            aspectSize(data.imageAspect ?? "landscape"),
          );
        }
          } catch (error) {
            console.error("[chat] image generation failed:", error);
          }
          return imageUrl;
        })();


    // مخرج واحد جاهز للنشر: نص المنشور نفسه هو أهم ما يراه المستخدم — نضعه في صدر الرد
    // ونضع تعليق الموظف بعده خلف فاصل، حتى تلتقطه لوحة النشر نظيفاً بلا كلام موظف.
    if (deliverables.length === 1) {
      const postBody = (deliverables[0]?.body ?? "").trim();
      const head = postBody.slice(0, 40);
      if (postBody.length > 60 && head && !reply.includes(head)) {
        const note = reply.trim();
        reply = note ? `${postBody}\n\n---\n\n**ملاحظة للمستخدم:** ${note}` : postBody;
      }
    }

    reply = sanitizeActionClaims(reply, connected);
    // منع التكرار: أحياناً يعيد النموذج نفس الفقرة مرتين (ملخص + مخرج) — نُبقي أول ظهور فقط.
    reply = dedupeParagraphs(reply);

    // حَكَم الجودة يعمل بالتوازي مع توليد الصورة: مراجعة إلزامية للمخرجات الطويلة
    // وإصلاح واحد موجّه عند الرسوب، بلا إضافة أي انتظار فوق زمن الصورة.
    const shouldJudge = intent === "work" && reply.length > 900;
    if (shouldJudge) emit({ type: "step", label: "أراجع جودة المخرج قبل تسليمه لك" });
    const judgeTask = !shouldJudge
      ? Promise.resolve(null)
      : import("./quality-judge.server")
          .then(({ judgeAndImprove }) =>
            judgeAndImprove({
              employeeId: data.employeeId,
              request: data.message,
              output: reply,
              criteria: qualityCriteria[data.employeeId] ?? [],
              bannedWords: workspace.banned_words ?? [],
            }),
          )
          .catch((error: unknown) => {
            console.warn("[judge] skipped:", error instanceof Error ? error.message : error);
            return null;
          });

    const [imageUrl, verdict] = await Promise.all([imageTask, judgeTask]);
    let qualityScore: number | null = verdict?.score || null;
    if (verdict?.revised) {
      // مخرج واحد فقط: نجعل المهمة المحفوظة مطابقة تماماً لما يظهر في المحادثة.
      if (deliverables.length === 1 && deliverables[0]?.body) {
        deliverables[0]!.body = verdict.output;
      }
      reply = verdict.output;
    }

    const footers = toolBlocks.map((t) => t.footer).filter(Boolean);
    if (footers.length) reply = `${reply.trim()}\n\n> ${footers.join(" · ")}`;

    if (imageUrl) {
      const alt = (deliverables[0]?.title ?? "الصورة المولّدة").slice(0, 120);
      reply = `${reply.trim()}\n\n![${alt}](${imageUrl})`;
    } else if (explicitImage) {
      // طلب صورة صريح ولم ينجح التوليد: نصرّح بذلك بدل ترك المستخدم مع وصف نصي فقط.
      reply = `${reply.trim()}\n\n> تعذّر توليد الصورة الآن. أعد الطلب بعد لحظات أو اكتب وصف الصورة بنفسك من زر الصورة في مربع الإرسال.`;
    }

    if (research.used.length) {
      reply = `${reply.trim()}\n\n— استندتُ إلى بيانات حقيقية: ${research.used.join(" · ")}`;
    }

    // عدة مخرجات: كل مخرج مستقل — نوجّه المستخدم إليها بدل محرّر واحد.
    if (deliverables.length > 1) {
      const allPosts = deliverables.every((d) => Boolean(d.channel));
      reply = allPosts
        ? `${reply.trim()}\n\n📋 جهّزت **${deliverables.length} منشورات** منفصلة، كل منشور بنصه ومنصته وموعده — راجعها واعتمدها من [المخرجات والمهام](/app/tasks).`
        : `${reply.trim()}\n\n📋 جهّزت **${deliverables.length} مخرجات** جاهزة، كل واحد بنصه الكامل — راجعها واعتمدها من [المخرجات والمهام](/app/tasks).`;
    }

    // صور من موقع المستخدم: اختيارية تماماً — تظهر فقط حين يطلبها في رسالته.
    const wantsSiteImages =
      /(صور|صورة|صور\s*من)\s*(من\s*)?(موقعي|الموقع|موقعنا)|صور\s+موقع|من\s+صور\s+موقعي|استخدم\s+صور\s+موقع/u.test(
        data.message ?? "",
      );
    let siteSuggestions: { url: string; alt: string; pageUrl: string }[] = [];
    if (wantsSiteImages)
      try {
        const { data: stored } = await supabase
          .from("site_assets")
          .select("url, alt, page_url, weight")
          .eq("workspace_id", data.workspaceId)
          .order("weight", { ascending: false })
          .limit(120);

        let pool = (stored ?? []).map((a) => ({
          url: a.url,
          alt: a.alt ?? "",
          pageUrl: a.page_url ?? "",
          weight: a.weight ?? 0,
        }));

        // أول مرة: نلتقط صور الموقع الآن ثم نحفظها للمرات القادمة.
        if (!pool.length && workspace?.website) {
          const { harvestSiteImages } = await import("./brand-assets.server");
          const found = await harvestSiteImages(workspace.website, 10);
          if (found.length) {
            await supabase.from("site_assets").upsert(
              found.map((a) => ({
                workspace_id: data.workspaceId,
                url: a.url,
                page_url: a.pageUrl,
                alt: a.alt || null,
                weight: a.weight,
                source: "website",
                kind: "image",
              })),
              { onConflict: "workspace_id,url" },
            );
            pool = found.map((a) => ({
              url: a.url,
              alt: a.alt,
              pageUrl: a.pageUrl,
              weight: a.weight,
            }));
          }
        }

        if (pool.length) {
          const { rankAssets } = await import("./brand-assets.server");
          const query = `${data.message}\n${deliverables.map((d) => `${d.title ?? ""} ${d.body ?? ""}`).join("\n")}`;
          siteSuggestions = rankAssets(query, pool, 12).map((a) => ({
            url: a.url,
            alt: a.alt,
            pageUrl: a.pageUrl,
          }));
        }
      } catch (e) {
        console.error("[site-assets] suggestion failed:", e);
      }

    if (siteSuggestions.length) {
      const gallery = siteSuggestions
        .map((s, i) => {
          const label = s.alt?.trim() || `صورة من موقعك ${i + 1}`;
          const page = s.pageUrl ? ` — [مصدرها](${s.pageUrl})` : "";
          return `![${label}](${s.url})\n*${label}*${page}`;
        })
        .join("\n\n");
      reply = `${reply.trim()}\n\n### 📸 صور من موقعك تصلح لهذا المحتوى\n\n${gallery}\n\nاختر أي صورة منها بدل الصورة المولّدة — كلها صور حقيقية من موقعك.`;
    }



    emit({ type: "step", label: "أحفظ الرد والمخرجات في مساحتك" });

    // ذاكرة القرارات تُستخلص بالتوازي مع الحفظ بدل أن تُضاف إلى زمن انتظار المستخدم.
    const decisionsTask: Promise<number> =
      reply.length > 200
        ? import("./decisions.server")
            .then(async ({ extractDecisions, recordDecisions }) =>
              recordDecisions(supabase as never, {
                workspaceId: data.workspaceId,
                employeeId: data.employeeId,
                conversationId: data.conversationId,
                drafts: await extractDecisions(data.message, reply),
              }),
            )
            .catch((error: unknown) => {
              console.warn(
                "[decisions] capture skipped:",
                error instanceof Error ? error.message : error,
              );
              return 0;
            })
        : Promise.resolve(0);

    // صورة المخرج: المولّدة، وإلا صورة أرفقها المستخدم فقط — لا نُلصق صور الموقع تلقائياً.
    const mediaUrl =
      imageUrl ??
      attachments.find((a) => a.type === "image")?.url ??
      (wantsSiteImages ? (siteSuggestions[0]?.url ?? null) : null);

    // الرسالة والمخرجات تُحفظ في دفعة واحدة متوازية — خطة من ١٢ منشوراً كانت
    // تنتظر ١٢ رحلة متسلسلة إلى قاعدة البيانات.
    const [messageInsert, taskRows, savedDecisions] = await Promise.all([
      supabase
        .from("messages")
        .insert({
          workspace_id: data.workspaceId,
          employee_id: data.employeeId,
          role: "assistant",
          body: reply,
          conversation_id: data.conversationId,
        })
        .select()
        .single(),
      Promise.all(
        deliverables.map(async (deliverable) => {
          const output = mediaUrl
            ? `![${deliverable.title}](${mediaUrl})\n\n${deliverable.body!}`
            : deliverable.body!;
          const { data: task } = await supabase
            .from("tasks")
            .insert({
              workspace_id: data.workspaceId,
              employee_id: data.employeeId,
              title: deliverable.title!,
              detail: reply.slice(0, 400),
              kind: deliverable.kind ?? persona.kind,
              channel: deliverable.channel ?? persona.channel,
              status: "review",
              output,
              scheduled: deliverable.scheduled ?? "بانتظار اعتمادك",
              steps: [
                { label: "فهم الطلب", state: "done" },
                { label: "التنفيذ", state: "done" },
                { label: "مراجعتك", state: "active" },
                { label: "النشر", state: "todo" },
              ],
            })
            .select("id")
            .single();
          return task?.id ?? null;
        }),
      ),
      decisionsTask,
    ]);
    const { data: assistantRow, error: assistantError } = messageInsert;
    if (assistantError) throw new Error(assistantError.message);
    const createdTaskId = taskRows.find((id): id is string => Boolean(id)) ?? null;


    return {
      qualityScore,
      savedDecisions,
      reply,
      messageId: assistantRow.id,
      createdTaskId,
      needsConnection,
      imageUrl,
      siteSuggestions,
    };
  }
}


const skillInput = z.object({
  workspaceId: z.string().uuid(),
  employeeId: z.string().min(1),
  skillId: z.string().min(1),
  values: z.record(z.string(), z.string()),
  conversationId: z.string().uuid(),
});

/** تشغيل قدرة محددة: يخرج مخرجاً جاهزاً ويحفظه كمهمة بانتظار الاعتماد. */
export const runSkill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => skillInput.parse(data))
  .handler(async ({ data, context }) => {
    const run = await executeSkill(context.supabase, {
      workspaceId: data.workspaceId,
      employeeId: data.employeeId,
      skillId: data.skillId,
      values: data.values,
      conversationId: data.conversationId,
    });
    return { output: run.output, messageId: run.messageId, taskId: run.taskId };
  });
