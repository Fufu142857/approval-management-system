import { notFound } from "next/navigation";
import { z } from "zod";
import { requireBusinessPageUser } from "@/server/page-auth";
import { PurchaseDetail } from "@/components/purchase-detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireBusinessPageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return <PurchaseDetail key={id} id={id} viewerId={user.id} />;
}
