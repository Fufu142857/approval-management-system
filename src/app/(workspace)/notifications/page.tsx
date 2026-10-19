import Link from "next/link";
import { requireBusinessPageUser } from "@/server/page-auth";
import { notificationListSchema } from "@/lib/notifications";
import { NotificationListPanel } from "@/components/notification-panels";
import { Notice } from "@/components/ui";
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireBusinessPageUser();
  const parsed = notificationListSchema.safeParse({
    pageSize: "10",
    ...(await searchParams),
  });
  if (!parsed.success)
    return (
      <div className="stack">
        <Notice error>查询参数无效，请重置后再查询。</Notice>
        <Link href="/notifications">重置查询</Link>
      </div>
    );
  return (
    <NotificationListPanel
      key={JSON.stringify(parsed.data)}
      input={parsed.data}
    />
  );
}
