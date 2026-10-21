import { PurchaseListPage } from "@/components/purchase-list-page";
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <PurchaseListPage mode="pending" searchParams={searchParams} />;
}
