import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * جدولة مهام نور: تعمل تلقائياً (يومياً/أسبوعياً/شهرياً) بنفس نواة التنفيذ اليدوية،
 * فتحصل على مخرجات جاهزة بلا أي طلب منك — وهذا ما يجعل نور موظفة تعمل لا أداة تنتظر.
 */

export const cadences = ["daily", "weekly", "monthly"] as const;
export type Cadence = (typeof cadences)[number];

/** يحسب موعد التشغيل القادم بتوقيت UTC انطلاقاً من التكرار واليوم والساعة. */
export function nextRun(
  cadence: Cadence,
  dayOfWeek: number,
  hour: number,
  from: Date = new Date(),
): Date {
  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(hour);

  if (cadence === "daily") {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (cadence === "weekly") {
    const delta = (dayOfWeek - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + delta);
    if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }

  // شهرياً: أول يوم مطابق في الشهر القادم إن فات موعد هذا الشهر
  next.setUTCDate(1);
  const delta = (dayOfWeek - next.getUTCDay() + 7) % 7;
  next.setUTCDate(1 + delta);
  if (next <= from) {
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    const d = (dayOfWeek - next.getUTCDay() + 7) % 7;
    next.setUTCDate(1 + d);
  }
  return next;
}

const base = {
  workspaceId: z.string().uuid(),
};

export const listAutomations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object(base).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("automations")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { automations: rows ?? [] };
  });

export const saveAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        ...base,
        id: z.string().uuid().optional(),
        employeeId: z.string().min(1).default("nour"),
        skillId: z.string().min(1),
        label: z.string().min(2).max(160),
        values: z.record(z.string(), z.string()),
        cadence: z.enum(cadences),
        dayOfWeek: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
        autoPublish: z.boolean().default(false),
        active: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const row = {
      workspace_id: data.workspaceId,
      employee_id: data.employeeId,
      skill_id: data.skillId,
      label: data.label,
      values: data.values,
      cadence: data.cadence,
      day_of_week: data.dayOfWeek,
      hour: data.hour,
      auto_publish: data.autoPublish,
      active: data.active,
      next_run_at: nextRun(data.cadence, data.dayOfWeek, data.hour).toISOString(),
    };

    if (data.id) {
      const { error } = await context.supabase
        .from("automations")
        .update(row)
        .eq("id", data.id)
        .eq("workspace_id", data.workspaceId);
      if (error) throw new Error(error.message);
      return { ok: true as const, id: data.id };
    }

    const { data: created, error } = await context.supabase
      .from("automations")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, id: created.id };
  });

export const toggleAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ...base, id: z.string().uuid(), active: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("automations")
      .update({ active: data.active })
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const deleteAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ...base, id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("automations")
      .delete()
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** تشغيل فوري لجدولة محددة (لتجربتها قبل انتظار موعدها). */
export const runAutomationNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ...base, id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("automations")
      .select("*")
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("الجدولة غير موجودة.");

    const { executeSkill } = await import("./nour-run.server");
    const run = await executeSkill(context.supabase, {
      workspaceId: data.workspaceId,
      employeeId: row.employee_id,
      skillId: row.skill_id,
      values: (row.values as Record<string, string> | null) ?? {},
      origin: "تشغيل يدوي للجدولة",
    });

    await context.supabase
      .from("automations")
      .update({ last_run_at: new Date().toISOString(), last_status: "نجح" })
      .eq("id", data.id);

    return { ok: true as const, taskId: run.taskId, title: run.title };
  });
