import { requirePageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { UsersPanel } from "@/components/users-panel";
export default async function UsersPage() {
  const user = await requirePageUser(true);
  return (
    <UsersPanel currentUserId={user.id} departments={await listDepartments()} />
  );
}
