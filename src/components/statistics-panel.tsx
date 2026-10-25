"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  errorMessage,
  handleSessionError,
  RequestError,
} from "@/lib/api-client";
import {
  statisticsSchema,
  statisticsStatuses,
  type FixedBusinessStatistics,
  type StatisticsInput,
} from "@/lib/statistics";
import type { Department } from "@/lib/identity-display";
import { Field, Notice } from "./ui";

const names = { travel: "差旅", purchase: "采购", reimbursement: "报销" };
const amounts = {
  travel: "已批准差旅预算",
  purchase: "已批准采购总额",
  reimbursement: "已批准报销总额",
};
const statuses = {
  pending: "审批中",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};
function query(input: StatisticsInput) {
  return new URLSearchParams(
    Object.entries(input).filter(([, value]) => !!value),
  ).toString();
}
// Amounts remain decimal strings, including aggregates beyond Number's safe precision.
function money(value: string) {
  const [whole, fraction] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
export function StatisticsPanel({
  input,
  departments,
  departmentId,
  canViewDepartment,
}: {
  input: StatisticsInput;
  departments: Department[];
  departmentId: string;
  canViewDepartment: boolean;
}) {
  const router = useRouter();
  const [scope, setScope] = useState(input.scope);
  const [validation, setValidation] = useState("");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: FixedBusinessStatistics;
    error?: string;
  }>();
  const path = `/statistics?${query(input)}`;
  const key = `${path}:${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    api<FixedBusinessStatistics>(path, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (
          !(
            error instanceof RequestError &&
            error.code === "STATISTICS_FORBIDDEN"
          ) &&
          handleSessionError(error)
        )
          return;
        setResult({ key, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [key, path]);
  const current = result?.key === key ? result : undefined;
  const data = current?.data;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(
      [...new FormData(event.currentTarget)].filter(
        ([, value]) => value !== "",
      ),
    );
    const parsed = statisticsSchema.safeParse(values);
    if (!parsed.success) {
      setValidation("请检查日期范围，结束日期不能早于开始日期。");
      return;
    }
    setValidation("");
    if (query(parsed.data) === query(input)) setRevision((n) => n + 1);
    else router.push(`/statistics?${query(parsed.data)}`);
  }
  const unknownDepartment =
    input.departmentId && !departments.some((d) => d.id === input.departmentId);
  return (
    <div className="stack statistics-page">
      <section
        className="panel stack"
        aria-labelledby="statistics-filter-heading"
      >
        <h2 id="statistics-filter-heading">统计筛选</h2>
        <form onSubmit={submit} className="stack">
          <div className="statistics-filters">
            <Field label="统计范围" name="scope">
              <select
                id="scope"
                name="scope"
                value={scope}
                onChange={(e) =>
                  setScope(e.target.value as StatisticsInput["scope"])
                }
              >
                <option value="personal">本人申请</option>
                {canViewDepartment && (
                  <option value="department">本部门申请</option>
                )}
              </select>
            </Field>
            <Field label="申请所属部门" name="departmentId">
              <select
                key={scope}
                id="departmentId"
                name="departmentId"
                defaultValue={
                  scope === "department"
                    ? departmentId
                    : (input.departmentId ?? "")
                }
              >
                {scope === "personal" && <option value="">全部部门</option>}
                {departments
                  .filter((d) => scope === "personal" || d.id === departmentId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                {scope === "personal" && unknownDepartment && (
                  <option value={input.departmentId}>
                    所选历史或不可用部门
                  </option>
                )}
              </select>
            </Field>
            <Field label="申请类型" name="type">
              <select id="type" name="type" defaultValue={input.type}>
                <option value="all">全部固定业务</option>
                {Object.entries(names).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}申请
                  </option>
                ))}
              </select>
            </Field>
            <Field label="提交开始日期" name="from">
              <input
                id="from"
                name="from"
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                defaultValue={input.from}
              />
            </Field>
            <Field label="提交结束日期" name="to">
              <input
                id="to"
                name="to"
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                defaultValue={input.to}
              />
            </Field>
          </div>
          {validation && <Notice error>{validation}</Notice>}
          <div className="actions">
            <button className="button" type="submit">
              查询
            </button>
            <Link
              className="button secondary"
              href="/statistics"
              prefetch={false}
            >
              重置筛选
            </Link>
            <button
              className="button secondary"
              type="button"
              disabled={!current}
              onClick={() => setRevision((n) => n + 1)}
            >
              刷新统计
            </button>
          </div>
        </form>
        <p className="muted">
          按申请提交日期统计（上海时间，包含起止日期），不含草稿。状态为当前状态；修改筛选后点击查询。
        </p>
      </section>
      <section aria-label="统计结果" aria-busy={!current} className="stack">
        {!current && <Notice>正在读取统计…</Notice>}
        {current?.error && (
          <Notice error>
            {current.error} 当前没有可展示的统计结果。请刷新统计重试，或
            <Link href="/statistics">返回本人统计</Link>。
          </Notice>
        )}
        {data && (
          <>
            <div className="page-heading">
              <h2>
                {data.filters.scope === "department"
                  ? "本部门申请统计"
                  : "本人申请统计"}
              </h2>
              <span className="muted">
                提交日期：{data.filters.from ?? "不限"} 至{" "}
                {data.filters.to ?? "不限"}
              </span>
            </div>
            <p className="muted">
              当前结果：
              {data.filters.type === "all"
                ? "全部固定业务"
                : `${names[data.filters.type]}申请`}{" "}
              ·{" "}
              {data.filters.departmentId
                ? (departments.find((d) => d.id === data.filters.departmentId)
                    ?.name ?? "所选历史或不可用部门")
                : "全部部门"}
              。部门汇总不授予申请正文或附件访问权限。
            </p>
            <div className="statistics-overview">
              <article className="panel">
                <h3>已提交申请</h3>
                <p className="statistics-number" data-testid="statistics-total">
                  {data.applications.total}
                </p>
                <p className="muted">当前范围内的申请总数</p>
              </article>
              <article className="panel">
                <h3>本人实际待办</h3>
                <p className="statistics-number" data-testid="statistics-tasks">
                  {data.pendingTasks.total}
                </p>
                <p className="muted">
                  始终只计分配给本人的当前任务，独立于申请范围；同样按申请提交日、部门和类型筛选。
                </p>
              </article>
            </div>
            <section
              className="panel stack"
              aria-labelledby="statistics-status-heading"
            >
              <h2 id="statistics-status-heading">申请状态分布</h2>
              {!data.applications.total && <p>当前筛选下暂无已提交申请。</p>}
              <ul className="statistics-chart">
                {statisticsStatuses.map((status) => (
                  <li key={status} data-testid={`statistics-${status}`}>
                    <span>{statuses[status]}</span>
                    <span className="statistics-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${data.applications.total ? (data.applications.statuses[status] / data.applications.total) * 100 : 0}%`,
                        }}
                      />
                    </span>
                    <strong>{data.applications.statuses[status]} 单</strong>
                  </li>
                ))}
              </ul>
            </section>
            <section
              className="stack"
              aria-labelledby="statistics-amount-heading"
            >
              <h2 id="statistics-amount-heading">分类统计与批准金额</h2>
              <p className="muted">
                仅计已通过申请。采购明细总额、差旅预算、报销费用分别统计，不跨类型相加。
              </p>
              <div className="statistics-types">
                {data.applications.byType.map((group) => (
                  <article
                    className="panel stack"
                    key={group.type}
                    aria-label={`${names[group.type]}统计`}
                  >
                    <h3>{names[group.type]}申请</h3>
                    <p>{amounts[group.type]}（元）</p>
                    <p className="statistics-amount">
                      {group.approvedAmount === null
                        ? "无法完整合计"
                        : money(group.approvedAmount)}
                    </p>
                    {group.approvedAmountMissingCount > 0 && (
                      <p role="status">
                        {group.approvedAmountMissingCount}{" "}
                        单已批准申请缺少金额，不能按零计入。
                      </p>
                    )}
                    <dl className="statistics-breakdown">
                      <div>
                        <dt>已提交</dt>
                        <dd>{group.total} 单</dd>
                      </div>
                      {statisticsStatuses.map((status) => (
                        <div key={status}>
                          <dt>{statuses[status]}</dt>
                          <dd>{group.statuses[status]} 单</dd>
                        </div>
                      ))}
                      <div>
                        <dt>本人实际待办</dt>
                        <dd>
                          {data.pendingTasks.byType.find(
                            (task) => task.type === group.type,
                          )?.count ?? 0}{" "}
                          项
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </section>
    </div>
  );
}
