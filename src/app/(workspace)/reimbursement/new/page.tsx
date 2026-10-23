import { requireBusinessPageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { ReimbursementEditor } from "@/components/reimbursement-editor";
export default async function Page() {
  const user = await requireBusinessPageUser();
  const departments = await listDepartments();
  return (
    <ReimbursementEditor
      applicant={user.fullName}
      department={
        departments.find((d) => d.id === user.departmentId)?.name ??
        "所属部门不可用"
      }
    />
  );
}
