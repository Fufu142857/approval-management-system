import { TravelListPage } from "@/components/travel-list-page";
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <TravelListPage mode="applications" searchParams={searchParams} />;
}
