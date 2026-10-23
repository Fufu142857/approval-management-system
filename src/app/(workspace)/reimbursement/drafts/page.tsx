import { requireBusinessPageUser } from "@/server/page-auth";
import { ReimbursementDraftsPanel } from "@/components/reimbursement-drafts-panel";
export default async function Page() {
  await requireBusinessPageUser();
  return <ReimbursementDraftsPanel />;
}
