import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { guestSession } from "@/lib/guest.functions";
import { BrandLoader } from "@/components/site/BrandLoader";

/**
 * فتح جلسة التجربة مرة واحدة فقط لكل تبويب: عدة نداءات متوازية (فتح أكثر من صفحة
 * في نفس اللحظة) كانت تُبطل رمز الدخول السابق فيظهر خطأ 403.
 */
let guestLogin: ReturnType<typeof openGuestSession> | null = null;

async function openGuestSession() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { tokenHash } = await guestSession();
    const { data: verified, error } = await supabase.auth.verifyOtp({
      type: "email",
      token_hash: tokenHash,
    });
    if (!error && verified.user) return verified.user;
    // رمز أُبطل بسبب نداء متزامن: نعيد المحاولة مرة واحدة برمز جديد.
    const { data: retry } = await supabase.auth.getUser();
    if (retry.user) return retry.user;
    if (attempt === 1) throw new Error(error?.message ?? "تعذّر فتح جلسة التجربة");
  }
  throw new Error("تعذّر فتح جلسة التجربة");
}

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) return { user: data.user };

    // لا تسجيل: نفتح جلسة تجربة تلقائياً (نداء واحد مشترك لكل المحاولات المتوازية).
    guestLogin ??= openGuestSession();
    try {
      const user = await guestLogin;
      return { user };
    } catch (e) {
      guestLogin = null;
      throw e;
    }
  },
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  pendingMs: 150,
  pendingComponent: () => (
    <div className="grid min-h-dvh place-items-center bg-background px-6 text-center">
      <div className="flex flex-col items-center">
        <BrandLoader size="lg" label={null} />
        <p className="mt-4 font-display text-lg font-black">نجهّز مساحة عملك…</p>
        <p className="mt-1 text-sm text-muted-foreground">ثوانٍ قليلة ويكون فريقك جاهزًا.</p>
      </div>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="grid min-h-dvh place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <p className="font-display text-lg font-black">تعذّر فتح مساحة العمل</p>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <a
          href="/app"
          className="mt-4 inline-block rounded-xl bg-foreground px-4 py-2 text-sm font-bold text-background"
        >
          حاول مرة أخرى
        </a>
      </div>
    </div>
  ),
  component: () => <Outlet />,
});
