import { requireBusinessPageUser } from "@/server/page-auth";
import { TravelDraftsPanel } from "@/components/travel-drafts-panel";
export default async function Page() {
  await requireBusinessPageUser();
  return <TravelDraftsPanel />;
}
