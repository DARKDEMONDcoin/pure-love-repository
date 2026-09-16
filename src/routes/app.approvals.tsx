import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, X, PartyPopper, Loader2 } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { PublishPanel } from "@/components/app/PublishPanel";
import { AppIcon, appLabel } from "@/components/site/AppIcon";
import { getMember } from "@/data/team";
import { useTasks, useUpdateTask, useWorkspace } from "@/lib/data";
import { sanitizePostBody } from "@/lib/post-format";
import { BrandLoader } from "@/components/site/BrandLoader";
import { Portrait } from "@/components/site/Portrait";


export const Route = createFileRoute("/app/approvals")({
  head: () => ({
    meta: [
      { title: "الموافقات | سهل" },
      { name: "description", content: "راجع ما أنجزه فريقك واعتمده قبل النشر." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { data: workspace } = useWorkspace();
  const { data: tasks, isLoading } = useTasks(workspace?.id);
  const update = useUpdateTask(workspace?.id);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = (tasks ?? []).filter((t) => t.status === "review");

  const act = async (id: string, status: "done" | "rejected") => {
    setBusyId(id);
    const steps =
      status === "done"
        ? [
            { label: "فهم الطلب", state: "done" },
            { label: "التنفيذ", state: "done" },
            { label: "مراجعتك", state: "done" },
            { label: "النشر", state: "done" },
          ]
        : undefined;
    try {
      await update.mutateAsync({ id, patch: steps ? { status, steps } : { status } });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell
      title="طابور الموافقات"
      lead={`${pending.length} عنصراً بانتظارك`}
      actions={
        pending.length ? (
          <button
            onClick={async () => {
              for (const t of pending) await act(t.id, "done");
            }}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-foreground px-3 py-2.5 text-sm font-bold text-background sm:px-4"
          >
            <Check className="size-4" />
            <span className="hidden sm:inline">اعتماد الكل</span>
            <span className="sm:hidden">الكل</span>
          </button>
        ) : null
      }
    >
      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <BrandLoader size="sm" />
        </p>
      ) : pending.length === 0 ? (
        <div className="rounded-3xl border border-border bg-card p-14 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-jade/12 text-jade-deep">
            <PartyPopper className="size-7" />
          </span>
          <h2 className="mt-5 font-display text-2xl font-black">لا شيء ينتظرك</h2>
          <p className="mt-2 text-ink-soft">فريقك يكمل العمل — سنخبرك فور جاهزية عنصر جديد.</p>
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {pending.map((a) => {
            const member = getMember(a.employee_id);
            return (
              <article key={a.id} className="min-w-0 rounded-3xl border border-border bg-card p-5 sm:p-6">
                <div className="flex flex-wrap items-center gap-2.5 text-xs">
                  {member ? (
                    <span className="inline-flex items-center gap-1.5 font-bold">
                      <span
                        className="size-7 shrink-0 overflow-hidden rounded-lg"
                        style={{ background: member.tintSoft }}
                      >
                        <Portrait memberId={member.id} name={member.name} className="size-full" />
                      </span>
                      {member.name}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <AppIcon name={a.channel} className="size-3.5 shrink-0" />
                    {appLabel(a.channel)}
                  </span>
                  <span className="rounded-full bg-secondary px-2.5 py-0.5 font-bold">{a.kind}</span>
                  <span className="ms-auto text-muted-foreground">{a.scheduled ?? ""}</span>
                </div>

                <h2 className="mt-4 font-display text-lg font-black break-words">{a.title}</h2>
                <p className="mt-3 max-h-96 overflow-y-auto overflow-x-hidden rounded-2xl bg-secondary/50 p-4 leading-relaxed break-words whitespace-pre-wrap text-ink-soft">
                  {sanitizePostBody(a.output ?? a.detail) || a.detail}
                </p>



                {workspace?.id ? (
                  <PublishPanel
                    workspaceId={workspace.id}
                    employeeId={a.employee_id}
                    taskId={a.id}
                    channel={a.channel}
                    body={a.output ?? a.detail ?? ""}
                  />
                ) : null}

                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    onClick={() => void act(a.id, "done")}
                    disabled={busyId === a.id}
                    className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-bold transition-colors hover:bg-secondary disabled:opacity-60"
                  >
                    {busyId === a.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    اعتماد بدون نشر
                  </button>
                  <button
                    onClick={() => void act(a.id, "rejected")}
                    disabled={busyId === a.id}
                    className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-60"
                  >
                    <X className="size-4" /> رفض
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
