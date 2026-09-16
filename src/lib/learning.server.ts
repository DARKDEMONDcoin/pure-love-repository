import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

const HIGH_RISK = /ميزانية|سعر|خصم|نشر تلقائي|أرسل|راسل|وعد|صلاحية|دفع|عقد|قانون|طبي/i;
const clean = (text: string, max = 500) => text.replace(/\s+/g, " ").trim().slice(0, max);

export async function learningBlock(client: Client, workspaceId: string, employeeId: string) {
  const { data: settings } = await client
    .from("employee_learning_settings")
    .select("enabled, experiment_percent")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (settings?.enabled === false) return { block: "", lessonIds: [] as string[] };

  const { data } = await client
    .from("employee_lessons")
    .select("id, title, instruction, confidence, evidence_count, status, risk_level")
    .eq("workspace_id", workspaceId)
    .eq("employee_id", employeeId)
    .in("status", ["active", "approved"])
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("confidence", { ascending: false })
    .limit(6);
  const experimentPercent = settings?.experiment_percent ?? 10;
  const selected = (data ?? []).filter(
    (lesson) =>
      lesson.status === "active" ||
      (lesson.risk_level === "low" && Math.random() * 100 < experimentPercent),
  );
  if (!selected.length) return { block: "", lessonIds: [] as string[] };
  return {
    block: [
      "## دروس نشطة وتجارب منخفضة المخاطر لهذه العلامة",
      "طبّقها فقط عندما تلائم الطلب. لا تجعلها تتجاوز طلب المستخدم أو قواعد الأمان والصدق.",
      ...selected.map((lesson, index) => `${index + 1}) ${lesson.instruction}`),
    ].join("\n"),
    lessonIds: selected.map((lesson) => lesson.id),
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
  if (run?.id && ["approved", "edited", "rejected", "published"].includes(input.kind)) {
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
    if (before !== after)
      return `فضّل الصياغة والأسلوب اللذين استخدمهما المالك في النسخة المعدّلة: «${after}» بدل «${before}».`;
  }
  return null;
}

export async function buildLearningCandidates(
  client: Client,
  workspaceId: string,
  employeeId: string,
) {
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
    const key = instruction
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .slice(0, 8)
      .join(" ");
    const current = groups.get(key) ?? { instruction, evidence: [] };
    current.evidence?.push(item);
    groups.set(key, current);
  }

  let created = 0;
  const promoted = 0;
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
    // كل درس يبدأ كتجربة صامتة. دورة القياس وحدها تفعّل منخفض المخاطر بعد إثبات التحسن.
    const status = "approved";
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
        activated_at: null,
        expires_at: new Date(Date.now() + 120 * 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (!lesson) continue;
    created += 1;
  }
  return { created, promoted };
}

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** يقيس الدروس المرشحة من السجلات الحقيقية، ثم يفعّل النافع ويتراجع عن الضار. */
export async function runLearningCycle(client: Client, workspaceId: string) {
  const { data: settings } = await client
    .from("employee_learning_settings")
    .select("enabled, auto_promote_low_risk, minimum_evidence, minimum_improvement")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (settings?.enabled === false) return { created: 0, evaluated: 0, promoted: 0, rolledBack: 0 };

  const { data: employeeRows } = await client
    .from("employee_runs")
    .select("employee_id")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1000);
  const employees = [...new Set((employeeRows ?? []).map((row) => row.employee_id))];
  let created = 0;
  for (const employeeId of employees) {
    const result = await buildLearningCandidates(client, workspaceId, employeeId);
    created += result.created;
  }

  const { data: lessons } = await client
    .from("employee_lessons")
    .select("id, employee_id, status, risk_level")
    .eq("workspace_id", workspaceId)
    .in("status", ["approved", "active"])
    .limit(200);
  const minimumEvidence = Math.max(3, settings?.minimum_evidence ?? 3);
  const configuredImprovement = settings?.minimum_improvement ?? 4;
  const minimumImprovement =
    configuredImprovement > 1 ? configuredImprovement / 100 : configuredImprovement;
  let evaluated = 0;
  let promoted = 0;
  let rolledBack = 0;

  for (const lesson of lessons ?? []) {
    const { data: runs } = await client
      .from("employee_runs")
      .select("quality_score, outcome, applied_lesson_ids, created_at")
      .eq("workspace_id", workspaceId)
      .eq("employee_id", lesson.employee_id)
      .not("quality_score", "is", null)
      .order("created_at", { ascending: false })
      .limit(120);
    const candidateRows = (runs ?? []).filter((run) => run.applied_lesson_ids.includes(lesson.id));
    const baselineRows = (runs ?? []).filter((run) => !run.applied_lesson_ids.includes(lesson.id));
    if (candidateRows.length < minimumEvidence || baselineRows.length < minimumEvidence) continue;
    const candidateScore = average(candidateRows.slice(0, 30).map((run) => run.quality_score ?? 0));
    const baselineScore = average(baselineRows.slice(0, 30).map((run) => run.quality_score ?? 0));
    if (candidateScore === null || baselineScore === null) continue;
    const improvement = baselineScore > 0 ? (candidateScore - baselineScore) / baselineScore : 0;
    const rejected = candidateRows.slice(0, 30).some((run) => run.outcome === "rejected");
    const safetyPassed = !rejected && candidateScore >= 82;

    await client.from("employee_evaluations").insert({
      workspace_id: workspaceId,
      employee_id: lesson.employee_id,
      lesson_id: lesson.id,
      sample_size: Math.min(30, candidateRows.length),
      baseline_score: baselineScore,
      candidate_score: candidateScore,
      improvement,
      safety_passed: safetyPassed,
      details: { source: "measured_runs", rejected } as Json,
    });
    evaluated += 1;

    if (
      lesson.status === "approved" &&
      lesson.risk_level === "low" &&
      settings?.auto_promote_low_risk !== false &&
      safetyPassed &&
      improvement >= minimumImprovement
    ) {
      await client
        .from("employee_lessons")
        .update({ status: "active", activated_at: new Date().toISOString() })
        .eq("id", lesson.id);
      promoted += 1;
    } else if (lesson.status === "active" && (!safetyPassed || improvement < -minimumImprovement)) {
      await client.from("employee_lessons").update({ status: "rolled_back" }).eq("id", lesson.id);
      rolledBack += 1;
    }
  }
  return { created, evaluated, promoted, rolledBack };
}
