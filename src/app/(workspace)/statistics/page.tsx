import Link from "next/link";
import { Notice } from "@/components/ui";
import { StatisticsPanel } from "@/components/statistics-panel";
import { statisticsSchema } from "@/lib/statistics";
import { requireBusinessPageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireBusinessPageUser();
  const parsed = statisticsSchema.safeParse(await searchParams);
  if (!parsed.success)
    return (
      <Notice error>
        统计筛选参数无效，请检查日期、部门和类型。{" "}
        <Link href="/statistics">重置筛选</Link>
      </Notice>
    );
  const canViewDepartment = user.roles.includes("department_head");
  if (
    parsed.data.scope === "department" &&
    (!canViewDepartment ||
      (parsed.data.departmentId &&
        parsed.data.departmentId !== user.departmentId))
  )
    return (
      <Notice error>
        仅当前部门负责人可查看本部门统计。{" "}
        <Link href="/statistics">返回本人统计</Link>
      </Notice>
    );
  return (
    <StatisticsPanel
      key={JSON.stringify(parsed.data)}
      input={parsed.data}
      departments={await listDepartments()}
      departmentId={user.departmentId!}
      canViewDepartment={canViewDepartment}
    />
  );
}
