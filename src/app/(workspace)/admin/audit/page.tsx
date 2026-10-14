import { requirePageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { AuditPanel } from "@/components/audit-panel";
export default async function AuditPage() {
  await requirePageUser(true);
  return <AuditPanel departments={await listDepartments()} />;
}
