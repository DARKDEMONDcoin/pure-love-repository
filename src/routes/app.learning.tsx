import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  CheckCircle2,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { BrandLoader } from "@/components/site/BrandLoader";
import { Portrait } from "@/components/site/Portrait";
import { Button } from "@/components/ui/button";
import { getMember, team } from "@/data/team";
import { useWorkspace } from "@/lib/data";
import {
  learningDashboard,
  updateLearningSettings,
  updateLessonStatus,
} from "@/lib/learning.functions";

export const Route = createFileRoute("/app/learning")({
  head: () => ({
    meta: [
      { title: "تطور فريق الذكاء الاصطناعي | سهل" },
      {
        name: "description",
        content: "تابع جودة موظفي الذكاء الاصطناعي والدروس المثبتة وتحكم في التعلم الآمن.",
      },
      { property: "og:title", content: "تطور فريق الذكاء الاصطناعي | سهل" },
      { property: "og:description", content: "لوحة قياس وتحكم في التحسين المستمر لموظفي سهل." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LearningPage,
});

const number = (value: number) => value.toLocaleString("ar-EG");
const pct = (value: number) => `${Math.round(value).toLocaleString("ar-EG")}%`;

function LearningPage() {
  const qc = useQueryClient();
  const { data: workspace } = useWorkspace();
  const load = useServerFn(learningDashboard);
  const updateSettings = useServerFn(updateLearningSettings);
  const setLesson = useServerFn(updateLessonStatus);
  const query = useQuery({
    queryKey: ["learning-dashboard", workspace?.id],
    enabled: Boolean(workspace?.id),
    queryFn: () => load({ data: { workspaceId: workspace?.id ?? "" } }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["learning-dashboard", workspace?.id] });
  const data = query.data;
  const enabled = data?.settings?.enabled ?? true;
  const scored = data?.runs.filter((run) => run.quality_score !== null) ?? [];
  const average = scored.length
    ? scored.reduce((sum, run) => sum + (run.quality_score ?? 0), 0) / scored.length
    : 0;
  const approved = data?.feedback.filter((item) => item.kind === "approved").length ?? 0;
  const rejected = data?.feedback.filter((item) => item.kind === "rejected").length ?? 0;
  const decisionTotal = approved + rejected;
  const activeLessons = data?.lessons.filter((lesson) => lesson.status === "active") ?? [];

  return (
    <AppShell title="تطور الفريق" lead="تحسين مستمر من ملاحظاتك والنتائج الحقيقية، مع تحكم كامل">
      {query.isLoading ? (
        <BrandLoader />
      ) : query.error ? (
        <p className="rounded-lg border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral">
          تعذّر تحميل بيانات التطور الآن.
        </p>
      ) : (
        <div className="space-y-7">
          <section className="flex flex-col justify-between gap-4 border-b border-border pb-6 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-jade/15 text-jade-deep">
                <ShieldCheck className="size-5" />
              </span>
              <div>
                <h2 className="font-display text-lg font-black">
                  التعلم الآمن {enabled ? "يعمل" : "متوقف"}
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  يتعلم كل موظف داخل مساحتك فقط. لا يغيّر صلاحياته أو القواعد الأساسية، ويمكنك إيقاف
                  أي درس أو التراجع عنه.
                </p>
              </div>
            </div>
            <Button
              variant={enabled ? "outline" : "default"}
              onClick={async () => {
                if (!workspace?.id) return;
                await updateSettings({ data: { workspaceId: workspace.id, enabled: !enabled } });
                await refresh();
              }}
            >
              {enabled ? <Pause /> : <Play />}
              {enabled ? "إيقاف التعلم" : "تشغيل التعلم"}
            </Button>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "المحاولات المقاسة", value: number(data?.runs.length ?? 0), icon: Activity },
              {
                label: "متوسط الجودة",
                value: scored.length ? pct(average) : "—",
                icon: TrendingUp,
              },
              {
                label: "الاعتماد من أول مرة",
                value: decisionTotal ? pct((approved / decisionTotal) * 100) : "—",
                icon: CheckCircle2,
              },
              { label: "دروس نشطة", value: number(activeLessons.length), icon: Sparkles },
            ].map((item) => (
              <article key={item.label} className="rounded-lg border border-border bg-card p-4">
                <item.icon className="size-5 text-primary" />
                <p className="mt-5 text-xs font-bold text-muted-foreground">{item.label}</p>
                <p className="mt-1 font-display text-2xl font-black">{item.value}</p>
              </article>
            ))}
          </section>

          <section>
            <h2 className="font-display text-xl font-black">أداء كل موظف</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {team.map((member) => {
                const runs = data?.runs.filter((run) => run.employee_id === member.id) ?? [];
                const scores = runs.filter((run) => run.quality_score !== null);
                const score = scores.length
                  ? scores.reduce((sum, run) => sum + (run.quality_score ?? 0), 0) / scores.length
                  : null;
                const lessons = activeLessons.filter(
                  (lesson) => lesson.employee_id === member.id,
                ).length;
                return (
                  <article
                    key={member.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card p-4"
                  >
                    <span className="size-12 shrink-0 overflow-hidden rounded-lg">
                      <Portrait memberId={member.id} name={member.name} className="size-full" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-black">{member.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {number(runs.length)} محاولة · {number(lessons)} درس
                      </p>
                    </div>
                    <strong className="text-lg">{score === null ? "—" : pct(score)}</strong>
                  </article>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="font-display text-xl font-black">الدروس والأدلة</h2>
            <div className="mt-3 space-y-3">
              {!data?.lessons.length ? (
                <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  ستظهر الدروس بعد تكرار ملاحظاتك أو تعديلاتك ثلاث مرات على الأقل.
                </p>
              ) : (
                data.lessons.map((lesson) => {
                  const member = getMember(lesson.employee_id);
                  return (
                    <article
                      key={lesson.id}
                      className="rounded-lg border border-border bg-card p-4"
                    >
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-muted-foreground">
                            {member?.name ?? lesson.employee_id} · {number(lesson.evidence_count)}{" "}
                            أدلة · ثقة {pct(lesson.confidence * 100)}
                          </p>
                          <h3 className="mt-1 font-black">{lesson.title}</h3>
                          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                            {lesson.instruction}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-bold ${lesson.status === "active" ? "bg-jade/15 text-jade-deep" : "bg-secondary text-muted-foreground"}`}
                        >
                          {lesson.status === "active"
                            ? "نشط"
                            : lesson.status === "rolled_back"
                              ? "متراجع عنه"
                              : "بانتظار المراجعة"}
                        </span>
                      </div>
                      <div className="mt-3 flex gap-2">
                        {lesson.status !== "active" ? (
                          <Button
                            size="sm"
                            onClick={async () => {
                              if (!workspace?.id) return;
                              await setLesson({
                                data: {
                                  workspaceId: workspace.id,
                                  lessonId: lesson.id,
                                  status: "active",
                                },
                              });
                              await refresh();
                            }}
                          >
                            <Play />
                            تفعيل
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              if (!workspace?.id) return;
                              await setLesson({
                                data: {
                                  workspaceId: workspace.id,
                                  lessonId: lesson.id,
                                  status: "rolled_back",
                                },
                              });
                              await refresh();
                            }}
                          >
                            <RotateCcw />
                            تراجع
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
