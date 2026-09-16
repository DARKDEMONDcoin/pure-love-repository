import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

async function owns(supabase: SupabaseClient<Database>, workspaceId: string) {
  const { data, error } = await supabase.rpc("owns_workspace", { _workspace_id: workspaceId });
  if (error || data !== true) throw new Error("غير مصرح لك بهذه المساحة.");
}

export const learningDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await owns(context.supabase, data.workspaceId);
    const [settings, runs, feedback, lessons, evaluations] = await Promise.all([
      context.supabase
        .from("employee_learning_settings")
        .select("*")
        .eq("workspace_id", data.workspaceId)
        .maybeSingle(),
      context.supabase
        .from("employee_runs")
        .select("employee_id, quality_score, outcome, was_revised, created_at")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(1000),
      context.supabase
        .from("employee_feedback")
        .select("employee_id, kind, created_at")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(1000),
      context.supabase
        .from("employee_lessons")
        .select("*")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(100),
      context.supabase
        .from("employee_evaluations")
        .select("lesson_id, improvement, safety_passed, sample_size, created_at")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    for (const result of [settings, runs, feedback, lessons, evaluations])
      if (result.error) throw new Error(result.error.message);
    return {
      settings: settings.data,
      runs: runs.data ?? [],
      feedback: feedback.data ?? [],
      lessons: lessons.data ?? [],
      evaluations: evaluations.data ?? [],
    };
  });

export const updateLearningSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ workspaceId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await owns(context.supabase, data.workspaceId);
    const { error } = await context.supabase.from("employee_learning_settings").upsert({
      workspace_id: data.workspaceId,
      enabled: data.enabled,
      paused_reason: data.enabled ? null : "أوقفه مالك المساحة",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateLessonStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        lessonId: z.string().uuid(),
        status: z.enum(["active", "rejected", "rolled_back"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await owns(context.supabase, data.workspaceId);
    const { error } = await context.supabase
      .from("employee_lessons")
      .update({
        status: data.status,
        activated_at: data.status === "active" ? new Date().toISOString() : null,
      })
      .eq("id", data.lessonId)
      .eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const saveLearningFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        taskId: z.string().uuid(),
        employeeId: z.string().min(1),
        kind: z.enum(["approved", "edited", "rejected", "published", "metric", "note"]),
        reason: z.string().max(700).nullish(),
        originalText: z.string().max(20000).nullish(),
        editedText: z.string().max(20000).nullish(),
        metrics: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await owns(context.supabase, data.workspaceId);
    const { recordTaskFeedback, buildLearningCandidates } = await import("./learning.server");
    await recordTaskFeedback(context.supabase, {
      workspaceId: data.workspaceId,
      taskId: data.taskId,
      employeeId: data.employeeId,
      kind: data.kind,
      reason: data.reason ?? null,
      originalText: data.originalText ?? null,
      editedText: data.editedText ?? null,
      metrics: data.metrics ?? {},
    });
    await buildLearningCandidates(context.supabase, data.workspaceId, data.employeeId);
    return { ok: true };
  });
