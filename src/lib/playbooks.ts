/**
 * موجّه الأدلة الميدانية: يعيد كتلة الدليل الثابت المناسبة لكل موظف.
 * مصدر واحد يستخدمه مسار الدردشة ومسار تنفيذ المهارات معاً (منعاً للتباعد بينهما).
 */
import { socialPlaybookBlock } from "./social-playbook";
import { seoPlaybookBlock } from "./seo-playbook";
import { execPlaybookBlock } from "./exec-playbook";
import { salesPlaybookBlock } from "./sales-playbook";
import { designPlaybookBlock } from "./design-playbook";
import { analyticsPlaybookBlock } from "./analytics-playbook";
import { adsPlaybookBlock, isAdsRequest } from "./ads-playbook";

const CORE: Record<string, string> = {
  sonny: socialPlaybookBlock,
  nour: seoPlaybookBlock,
  eva: execPlaybookBlock,
  sam: salesPlaybookBlock,
  dana: designPlaybookBlock,
  adam: analyticsPlaybookBlock,
};

/**
 * كتلة الدليل لموظف. `message` اختياري: تُضاف كتلة الإعلانات لآدم/دانة/سالم
 * فقط عندما يكون الطلب إعلانياً فعلاً (لتوفير التوكنات وزمن الرد).
 */
export function playbookFor(employeeId: string, message?: string): string {
  const blocks: string[] = [];
  const core = CORE[employeeId];
  if (core) blocks.push(core);
  const adsRelevant =
    employeeId === "sonny" ||
    ((employeeId === "adam" || employeeId === "dana" || employeeId === "sam") &&
      !!message &&
      isAdsRequest(message));
  if (adsRelevant) blocks.push(adsPlaybookBlock());
  return blocks.filter(Boolean).join("\n\n");
}
