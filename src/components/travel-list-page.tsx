import Link from "next/link";
import { requireBusinessPageUser } from "@/server/page-auth";
import { travelApplicationListSchema } from "@/lib/travel-lists";
import { TravelListPanel, type TravelListMode } from "./travel-list-panel";
import { Notice } from "./ui";

export async function TravelListPage({
  mode,
  searchParams,
}: {
  mode: TravelListMode;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireBusinessPageUser();
  const query = await searchParams;
  const parsed = travelApplicationListSchema.safeParse({
    pageSize: "10",
    ...query,
  });
  if (!parsed.success)
    return (
      <div className="stack">
        <Notice error>查询参数无效，请重置后再查询。</Notice>
        <Link
          href={
            mode === "applications"
              ? "/travel/applications"
              : mode === "pending"
                ? "/travel/tasks"
                : "/travel/tasks/handled"
          }
        >
          重置查询
        </Link>
      </div>
    );
  return (
    <TravelListPanel
      key={`${mode}:${JSON.stringify(parsed.data)}`}
      mode={mode}
      input={parsed.data}
    />
  );
}
