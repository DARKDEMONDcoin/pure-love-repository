import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

const HIGH_RISK = /ميزانية|سعر|خصم|نشر تلقائي|أرسل|راسل|وعد|صلاحية|دفع|عقد|قانون|طبي/i;
const clean = (text: string, max = 500) => text.replace(/\s+/g, " ").trim().slice(0, max);

export async function learningBlock(client: Client, workspaceId: string, employeeId: string) {
  const { data: settings } = await client
    .from("employee_learning_settings")
    .select("enabled")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (settings?.enabled === false) return { block: "", lessonIds: [] as string[] };

  const { data } = await client
    .from("employee_lessons")
    .select("id, title, instruction, confidence, evidence_count")
    .eq("workspace_id", workspaceId)
    .eq("employee_id", employeeId)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("confidence", { ascending: false })
    .limit(6);
  if (!data?.length) return { block: "", lessonIds: [] as string[] };
  return {
    block: [
      "## دروس مثبت أثبتتها نتائج هذه العلامة",
      "طبّقها فقط عندما تلائم الطلب. لا تجعلها تتجاوز طلب المستخدم أو قواعد الأمان والصدق.",
      ...data.map((lesson, index) => `${index + 1}) ${lesson.instruction}`),
    ].join("\n"),
    lessonIds: data.map((lesson) => lesson.id),
  };
}

export async function recordEmployeeRun(
  client: Client,
  input: {
    workspaceId: string;
    employeeId: string;
    conversationId?: string | null;
    messageId?: string | null;
    taskId?: string | null;
    capability?: string | null;
    request: string;
    originalOutput: string;
    finalOutput: string;
    qualityScore?: number | null;
    issues?: string[];
    revised?: boolean;
    lessonIds?: string[];
  },
) {
  const { error } = await client.from("employee_runs").insert({
    workspace_id: input.workspaceId,
    employee_id: input.employeeId,
    conversation_id: input.conversationId ?? null,
    message_id: input.messageId ?? null,
    task_id: input.taskId ?? null,
    capability: input.capability ?? null,
    request_text: clean(input.request, 4000),
    original_output: input.originalOutput,
    final_output: input.finalOutput,
    quality_score: input.qualityScore ?? null,
    quality_issues: (input.issues ?? []) as Json,
    was_revised: input.revised ?? false,
    applied_lesson_ids: input.lessonIds ?? [],
  });
  if (error) console.warn("[learning] run capture skipped:", error.message);
}

export async function recordTaskFeedback(
  client: Client,
  input: {
    workspaceId: string;
    taskId: string;
    employeeId: string;
    kind: "approved" | "edited" | "rejected" | "published" | "metric" | "note";
    reason?: string | null;
    originalText?: string | null;
    editedText?: string | null;
    metrics?: Json;
  },
) {
  const { data: run } = await client
    .from("employee_runs")
    .select("id")
    .eq("task_id", input.taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  await client.from("employee_feedback").insert({
    workspace_id: input.workspaceId,
    employee_id: input.employeeId,
    run_id: run?.id ?? null,
    task_id: input.taskId,
    kind: input.kind,
    reason: input.reason ? clean(input.reason, 700) : null,
    original_text: input.originalText ?? null,
    edited_text: input.editedText ?? null,
    metrics: input.metrics ?? {},
    weight: input.kind === "rejected" || input.kind === "edited" ? 2 : 1,
  });
  if (run?.id) {
    await client.from("employee_runs").update({ outcome: input.kind }).eq("id", run.id);
  }
}

function lessonFromFeedback(row: {
  kind: string;
  reason: string | null;
  original_text: string | null;
  edited_text: string | null;
}) {
  if (row.reason && row.reason.trim().length >= 8) return clean(row.reason, 360);
  if (row.kind === "edited" && row.original_text && row.edited_text) {
    const before = clean(row.original_text, 220);
    const after = clean(row.edited_text, 220);
    if (before !== after) return `فضّل الصياغة والأسلوب اللذين استخدمهما المالك في النسخة المعدّلة: «${after}» بدل «${before}».`;
  }
  return null;
}

export async function buildLearningCandidates(client: Client, workspaceId: string, employeeId: string) {
  const { data: settings } = await client
    .from("employee_learning_settings")
    .select("enabled, auto_promote_low_risk, minimum_evidence, minimum_improvement")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (settings?.enabled === false) return { created: 0, promoted: 0 };
  const minimumEvidence = settings?.minimum_evidence ?? 3;

  const { data: feedback } = await client
    .from("employee_feedback")
    .select("kind, reason, original_text, edited_text, created_at")
    .eq("workspace_id", workspaceId)
    .eq("employee_id", employeeId)
    .in("kind", ["edited", "rejected", "note"])
    .order("created_at", { ascending: false })
    .limit(80);

  const groups = new Map<string, { instruction: string; evidence: typeof feedback }>();
  for (const item of feedback ?? []) {
    const instruction = lessonFromFeedback(item);
    if (!instruction) continue;
    const key = instruction.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").slice(0, 8).join(" ");
    const current = groups.get(key) ?? { instruction, evidence: [] };
    current.evidence?.push(item);
    groups.set(key, current);
  }

  let created = 0;
  let promoted = 0;
  for (const group of groups.values()) {
    const count = group.evidence?.length ?? 0;
    if (count < minimumEvidence) continue;
    const { data: exists } = await client
      .from("employee_lessons")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("employee_id", employeeId)
      .eq("instruction", group.instruction)
      .neq("status", "expired")
      .maybeSingle();
    if (exists) continue;
    const risk = HIGH_RISK.test(group.instruction) ? "high" : "low";
    const confidence = Math.min(0.95, 0.55 + count * 0.08);
    const status = risk === "low" && settings?.auto_promote_low_risk !== false ? "active" : "approved";
    const { data: lesson } = await client
      .from("employee_lessons")
      .insert({
        workspace_id: workspaceId,
        employee_id: employeeId,
        title: `درس من ${count.toLocaleString("ar-EG")} إشارات متكررة`,
        instruction: group.instruction,
        source_kind: "owner_feedback",
        status,
        risk_level: risk,
        confidence,
        evidence_count: count,
        evidence: group.evidence?.slice(0, 8) as unknown as Json,
        activated_at: status === "active" ? new Date().toISOString() : null,
        expires_at: new Date(Date.now() + 120 * 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (!lesson) continue;
    const baseline = 50;
    const candidate = Math.min(100, baseline + count * 2);
    await client.from("employee_evaluations").insert({
      workspace_id: workspaceId,
      employee_id: employeeId,
      lesson_id: lesson.id,
      sample_size: count,
      baseline_score: baseline,
      candidate_score: candidate,
      improvement: candidate - baseline,
      safety_passed: risk === "low",
      details: { method: "owner_feedback_repetition", evidence_count: count },
    });
    created += 1;
    if (status === "active") promoted += 1;
  }
  return { created, promoted };
}
