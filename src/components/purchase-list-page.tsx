import Link from "next/link";
import { requireBusinessPageUser } from "@/server/page-auth";
import { purchaseApplicationListSchema } from "@/lib/purchase-lists";
import {
  PurchaseListPanel,
  type PurchaseListMode,
} from "./purchase-list-panel";
import { Notice } from "./ui";

export async function PurchaseListPage({
  mode,
  searchParams,
}: {
  mode: PurchaseListMode;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireBusinessPageUser();
  const query = await searchParams;
  const parsed = purchaseApplicationListSchema.safeParse({
    pageSize: "10",
    ...query,
  });
  const allowed = [
    "page",
    "pageSize",
    "type",
    "status",
    "keyword",
    "from",
    "to",
  ];
  if (
    !parsed.success ||
    Object.keys(query).some((key) => !allowed.includes(key))
  )
    return (
      <div className="stack">
        <Notice error>查询参数无效，请重置后再查询。</Notice>
        <Link
          href={
            mode === "applications"
              ? "/purchase/applications"
              : mode === "pending"
                ? "/purchase/tasks"
                : "/purchase/tasks/handled"
          }
        >
          重置查询
        </Link>
      </div>
    );
  return (
    <PurchaseListPanel
      key={`${mode}:${JSON.stringify(parsed.data)}`}
      mode={mode}
      input={parsed.data}
    />
  );
}
