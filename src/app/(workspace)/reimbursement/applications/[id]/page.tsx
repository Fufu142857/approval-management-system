import { notFound } from "next/navigation";
import { z } from "zod";
import { requireBusinessPageUser } from "@/server/page-auth";
import { ReimbursementDetail } from "@/components/reimbursement-detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireBusinessPageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return <ReimbursementDetail key={id} id={id} />;
}
