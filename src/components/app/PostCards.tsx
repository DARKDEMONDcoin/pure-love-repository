/** بطاقة النشر الموحدة داخل المحادثة لكل الموظفين. */
import { PublishPanel } from "@/components/app/PublishPanel";

export function PostCards({
  workspaceId,
  employeeId,
  taskId,
  request,
  body,
  channel,
}: {
  workspaceId: string;
  employeeId: string;
  taskId?: string | null;
  request?: string | null;
  body: string;
  channel?: string | undefined;
}) {
  return (
    <PublishPanel
      workspaceId={workspaceId}
      employeeId={employeeId}
      taskId={taskId ?? null}
      request={request ?? null}
      body={body}
      channel={channel ?? "instagram"}
      defaultOpen
    />
  );
}
