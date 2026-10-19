import { z } from "zod";
import Link from "next/link";
import { requireBusinessPageUser } from "@/server/page-auth";
import { NotificationDetailPanel } from "@/components/notification-panels";
import { Notice } from "@/components/ui";
export default async function NotificationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireBusinessPageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return (
      <div className="stack">
        <Notice error>通知编号无效。</Notice>
        <Link href="/notifications">返回通知中心</Link>
      </div>
    );
  return <NotificationDetailPanel key={id} id={id} />;
}
