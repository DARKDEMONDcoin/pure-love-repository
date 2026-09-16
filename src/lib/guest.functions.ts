import { createServerFn } from "@tanstack/react-start";

/** حساب التجربة المشترك — لا تسجيل ولا كلمات مرور من المستخدم. */
export const GUEST_EMAIL = "guest@sahl.app";

/**
 * يهيّئ حساب التجربة (يُنشئه مرة واحدة مع مساحة عمله عبر trigger)
 * ويعيد رمز دخول لمرة واحدة يستخدمه المتصفح فوراً.
 */
export const guestSession = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users.find((u) => u.email === GUEST_EMAIL);

  if (!existing) {
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: GUEST_EMAIL,
      password: crypto.randomUUID() + crypto.randomUUID(),
      email_confirm: true,
      user_metadata: {
        full_name: "ضيف التجربة",
        company: "مساحة التجربة",
        industry: "عام",
        dialect: "خليجية",
      },
    });
    if (error && !/already/i.test(error.message)) throw new Error(error.message);
  }

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: GUEST_EMAIL,
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(error?.message ?? "تعذّر تهيئة جلسة التجربة");
  }

  return { tokenHash: data.properties.hashed_token };
});
