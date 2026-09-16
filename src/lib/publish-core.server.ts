/**
 * نشر تلقائي من الخادم (بدون جلسة مستخدم) — يُستخدم في الجدولة التلقائية.
 * يختار أول منصة نشر مربوطة لمساحة العمل بالترتيب: ووردبريس → Ghost → Shopify → Webflow،
 * ويحفظ المخرج كمسودة افتراضياً حتى لا يُنشر شيء بلا رغبة صريحة من صاحب العلامة.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { ghostPublish } from "./ghost.server";

type Admin = SupabaseClient<Database>;

export type AutoPublishResult = {
  provider: string;
  link: string | null;
  status: "draft" | "publish";
};

async function config<T>(admin: Admin, workspaceId: string, provider: string): Promise<T | null> {
  const { data } = await admin
    .from("integration_credentials")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  return (data?.config as T | undefined) ?? null;
}

async function connectedProviders(admin: Admin, workspaceId: string): Promise<Set<string>> {
  const { data } = await admin
    .from("integrations")
    .select("provider")
    .eq("workspace_id", workspaceId)
    .eq("status", "connected");
  return new Set((data ?? []).map((r) => r.provider));
}

export async function autoPublish(
  admin: Admin,
  workspaceId: string,
  article: { title: string; html: string },
  status: "draft" | "publish" = "draft",
): Promise<AutoPublishResult | null> {
  const connected = await connectedProviders(admin, workspaceId);

  if (connected.has("wordpress")) {
    const wp = await config<{ siteUrl: string; username: string; appPassword: string }>(
      admin,
      workspaceId,
      "wordpress",
    );
    if (wp?.siteUrl) {
      const res = await fetch(`${wp.siteUrl}/wp-json/wp/v2/posts`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${wp.username}:${wp.appPassword}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: article.title, content: article.html, status }),
      });
      if (res.ok) {
        const post = (await res.json()) as { link?: string };
        return { provider: "wordpress", link: post.link ?? null, status };
      }
      console.error("[auto-publish] wordpress failed", res.status);
    }
  }

  if (connected.has("ghost")) {
    const gh = await config<{ apiUrl: string; adminKey: string }>(admin, workspaceId, "ghost");
    if (gh?.apiUrl) {
      try {
        const post = await ghostPublish(gh, article, status);
        return { provider: "ghost", link: post.url ?? null, status };
      } catch (error) {
        console.error("[auto-publish] ghost failed", error);
      }
    }
  }

  if (connected.has("shopify")) {
    const sh = await config<{ shop: string; accessToken: string; blogId?: string }>(
      admin,
      workspaceId,
      "shopify",
    );
    if (sh?.shop && sh.blogId) {
      const res = await fetch(
        `https://${sh.shop}/admin/api/2024-10/blogs/${sh.blogId}/articles.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": sh.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            article: {
              title: article.title,
              body_html: article.html,
              published: status === "publish",
            },
          }),
        },
      );
      if (res.ok) {
        const created = (await res.json()) as { article?: { handle?: string } };
        return {
          provider: "shopify",
          link: created.article?.handle
            ? `https://${sh.shop}/blogs/news/${created.article.handle}`
            : null,
          status,
        };
      }
      console.error("[auto-publish] shopify failed", res.status);
    }
  }

  return null;
}
