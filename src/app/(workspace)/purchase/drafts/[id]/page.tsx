import { notFound } from "next/navigation";
import { z } from "zod";
import { requireBusinessPageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { ExistingPurchaseEditor } from "@/components/purchase-editor";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireBusinessPageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const departments = await listDepartments();
  return (
    <ExistingPurchaseEditor
      key={id}
      id={id}
      applicant={user.fullName}
      department={
        departments.find((d) => d.id === user.departmentId)?.name ??
        "所属部门不可用"
      }
    />
  );
}
