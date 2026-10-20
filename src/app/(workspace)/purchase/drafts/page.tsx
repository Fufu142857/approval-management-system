import { requireBusinessPageUser } from "@/server/page-auth";
import { PurchaseDraftsPanel } from "@/components/purchase-drafts-panel";
export default async function Page() {
  await requireBusinessPageUser();
  return <PurchaseDraftsPanel />;
}
