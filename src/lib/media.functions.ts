import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const generateInput = z.object({
  workspaceId: z.string().uuid(),
  prompt: z.string().min(3).max(1200),
  count: z.number().int().min(1).max(4).default(1),
  aspect: z.enum(["square", "portrait", "landscape", "story"]).default("square"),
  /** حرفي = وصف المستخدم كما هو (مترجَم فقط)، مُحسَّن = يُثريه مخرج الصور. */
  mode: z.enum(["literal", "enhanced"]).default("literal"),
});

/**
 * توليد صور بالذكاء الاصطناعي من وصف المستخدم نفسه — اختياري بالكامل،
 * بأي عدد (حتى 4) وأي نسبة أبعاد، ويُرفع كل أصل إلى مخزن مساحة العمل.
 */
export const generateMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => generateInput.parse(data))
  .handler(async ({ data, context }) => {
    const { data: workspace } = await context.supabase
      .from("workspaces")
      .select("id, name, industry, country")
      .eq("id", data.workspaceId)
      .maybeSingle();
    if (!workspace) throw new Error("مساحة العمل غير موجودة.");

    const { literalBrief, imageBrief, aspectSize, ownedHeroImage } = await import(
      "./image-gen.server"
    );
    const prompt =
      data.mode === "literal"
        ? await literalBrief(data.prompt)
        : await imageBrief({
            request: data.prompt,
            brand: {
              name: workspace.name,
              industry: workspace.industry,
              country: (workspace as { country?: string | null }).country ?? null,
            },
          });
    const size = aspectSize(data.aspect);

    const urls = await Promise.all(
      Array.from({ length: data.count }, (_, i) =>
        ownedHeroImage(
          context.supabase as unknown as Parameters<typeof ownedHeroImage>[0],
          data.workspaceId,
          prompt,
          { ...size, seed: Math.floor(Math.random() * 1_000_000) + i },
        ).catch(() => null),
      ),
    );

    return { prompt, urls: urls.filter((u): u is string => Boolean(u)) };
  });
