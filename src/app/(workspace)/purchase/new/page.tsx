import { requireBusinessPageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { PurchaseEditor } from "@/components/purchase-editor";
export default async function Page() {
  const user = await requireBusinessPageUser();
  const departments = await listDepartments();
  return (
    <PurchaseEditor
      applicant={user.fullName}
      department={
        departments.find((d) => d.id === user.departmentId)?.name ??
        "所属部门不可用"
      }
    />
  );
}
