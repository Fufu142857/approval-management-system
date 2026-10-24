import Link from "next/link";
import { requireBusinessPageUser } from "@/server/page-auth";
import { reimbursementApplicationListSchema } from "@/lib/reimbursement-lists";
import {
  ReimbursementListPanel,
  type ReimbursementListMode,
} from "./reimbursement-list-panel";
import { Notice } from "./ui";

export async function ReimbursementListPage({
  mode,
  searchParams,
}: {
  mode: ReimbursementListMode;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireBusinessPageUser();
  const query = await searchParams;
  const parsed = reimbursementApplicationListSchema.safeParse({
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
              ? "/reimbursement/applications"
              : mode === "pending"
                ? "/reimbursement/tasks"
                : "/reimbursement/tasks/handled"
          }
        >
          重置查询
        </Link>
      </div>
    );
  return (
    <ReimbursementListPanel
      key={`${mode}:${JSON.stringify(parsed.data)}`}
      mode={mode}
      input={parsed.data}
    />
  );
}
