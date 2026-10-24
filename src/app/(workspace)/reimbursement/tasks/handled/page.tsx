import { ReimbursementListPage } from "@/components/reimbursement-list-page";
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ReimbursementListPage mode="handled" searchParams={searchParams} />;
}
