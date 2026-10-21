"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  travelApplicationListSchema,
  travelStatuses,
  type TravelApplicationListInput,
  type TravelApplicationSummary,
  type TravelTaskSummary,
  type TravelList,
} from "@/lib/travel-lists";
import {
  travelStatusNames,
  taskStatusNames,
  travelTime,
} from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { Field, Notice, Pager } from "./ui";
import { TravelFailure } from "./travel-common";

export type TravelListMode = "applications" | "pending" | "handled";
export function TravelListNavigation({
  mode,
}: {
  mode: TravelListMode | "drafts";
}) {
  const items =
    mode === "applications" || mode === "drafts"
      ? [
          ["applications", "/travel/applications", "全部申请"],
          ["drafts", "/travel/drafts", "草稿管理"],
        ]
      : [
          ["pending", "/travel/tasks", "待办事项"],
          ["handled", "/travel/tasks/handled", "已办事项"],
        ];
  return (
    <nav className="management-tabs" aria-label="差旅列表导航">
      {(mode === "applications" || mode === "drafts") && (
        <Link href="/purchase/drafts" prefetch={false}>
          采购草稿
        </Link>
      )}
      <Link
        href={
          mode === "applications" || mode === "drafts"
            ? "/purchase/applications"
            : mode === "pending"
              ? "/purchase/tasks"
              : "/purchase/tasks/handled"
        }
        prefetch={false}
      >
        {mode === "applications" || mode === "drafts" ? "采购申请" : "采购任务"}
      </Link>
      {items.map(([key, href, label]) => (
        <Link
          key={key}
          href={href}
          prefetch={false}
          aria-current={mode === key ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function TravelListPanel({
  mode,
  input,
}: {
  mode: TravelListMode;
  input: TravelApplicationListInput;
}) {
  const router = useRouter();
  const [navigating, startTransition] = useTransition();
  function go(url: string) {
    startTransition(() => router.push(url, { scroll: false }));
  }
  const [form, setForm] = useState({
    status: input.status,
    keyword: input.keyword,
    from: input.from ?? "",
    to: input.to ?? "",
  });
  const [error, setError] = useState("");
  const own = mode === "applications";
  const path = own
    ? "/travel/applications"
    : mode === "pending"
      ? "/travel/tasks"
      : "/travel/tasks/handled";
  function params(value: TravelApplicationListInput) {
    return new URLSearchParams(
      Object.entries(value)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
  }
  const search = params(input);
  if (!own) search.set("state", mode);
  const resource = useResource<
    TravelList<TravelApplicationSummary | TravelTaskSummary>
  >(`${own ? "/travel-applications" : "/travel-tasks"}?${search}`);
  function navigate(value: TravelApplicationListInput) {
    go(`${path}?${params(value)}`);
  }
  const timeLabel = own
    ? "创建时间"
    : mode === "pending"
      ? "接收时间"
      : "处理时间";
  return (
    <div className="stack">
      <TravelListNavigation mode={mode} />
      <div className="page-heading">
        <div>
          <h2>
            {own
              ? "我的差旅申请"
              : mode === "pending"
                ? "待办事项"
                : "已办事项"}
          </h2>
          <p className="hint">
            {own
              ? "查看本人申请与当前审批进度"
              : mode === "pending"
                ? "进入详情核对内容后处理审批"
                : "本人已通过或驳回的审批任务；取消任务不计为已办"}
          </p>
        </div>
        {own && (
          <Link className="button" href="/travel/new" prefetch={false}>
            ＋ 新建差旅申请
          </Link>
        )}
      </div>
      <section className="panel table-panel" aria-label="差旅查询列表">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = travelApplicationListSchema.safeParse({
              ...input,
              ...form,
              from: form.from || undefined,
              to: form.to || undefined,
              page: 1,
            });
            if (!parsed.success) {
              setError(parsed.error.issues[0].message);
              return;
            }
            setError("");
            navigate(parsed.data);
          }}
        >
          <fieldset className="travel-list-filters" disabled={navigating}>
            <Field label="申请类型" name="list-type">
              <select
                id="list-type"
                value="travel"
                onChange={() =>
                  go(
                    own
                      ? "/purchase/applications"
                      : mode === "pending"
                        ? "/purchase/tasks"
                        : "/purchase/tasks/handled",
                  )
                }
              >
                <option value="travel">差旅申请</option>
                <option value="purchase">采购申请</option>
              </select>
            </Field>
            <Field label="申请状态" name="list-status">
              <select
                id="list-status"
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value as typeof form.status,
                  })
                }
              >
                <option value="all">全部状态</option>
                {travelStatuses
                  .filter((status) => own || status !== "draft")
                  .map((status) => (
                    <option key={status} value={status}>
                      {travelStatusNames[status]}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={`${timeLabel}起始日期`} name="list-from">
              <input
                id="list-from"
                type="date"
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            </Field>
            <Field label={`${timeLabel}结束日期`} name="list-to">
              <input
                id="list-to"
                type="date"
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
              />
            </Field>
            <Field label="关键词" name="list-keyword">
              <input
                id="list-keyword"
                maxLength={200}
                placeholder="申请标题或编号"
                value={form.keyword}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
              />
            </Field>
            <div className="actions">
              <button className="button" type="submit">
                查询
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setForm({ status: "all", keyword: "", from: "", to: "" });
                  setError("");
                  go(path);
                }}
              >
                重置
              </button>
              <button
                className="text-button"
                type="button"
                disabled={resource.loading}
                onClick={resource.reload}
              >
                刷新列表
              </button>
            </div>
          </fieldset>
        </form>
        {navigating && (
          <p className="empty-state" role="status">
            正在切换查询…
          </p>
        )}
        <p className="hint list-time-hint">
          按{timeLabel}筛选，日期包含首尾，使用北京时间。
          {!own && "申请状态为当前状态，审批结果按各节点分别记录。"}
        </p>
        {error && <Notice error>{error}</Notice>}
        {resource.loading && (
          <p className="empty-state" role="status">
            正在加载列表…
          </p>
        )}
        {resource.error && (
          <TravelFailure message={resource.error} retry={resource.reload} />
        )}
        {resource.data && (
          <>
            {!resource.data.items.length ? (
              <p className="empty-state">
                {resource.data.total
                  ? "本页没有记录，请返回上一页或重置查询"
                  : "没有符合条件的记录"}
              </p>
            ) : (
              <>
                <p className="scroll-hint">左右滑动可查看完整列表</p>
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="差旅查询表格"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>申请编号 / 类型</th>
                        <th>标题 / 申请人</th>
                        <th>申请状态</th>
                        {!own && <th>审批节点 / 结果</th>}
                        <th>当前审批人</th>
                        <th>{timeLabel}</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resource.data.items.map((item) => {
                        const task = "application" in item ? item : null;
                        const app = task
                          ? task.application
                          : (item as TravelApplicationSummary);
                        const time = task
                          ? mode === "pending"
                            ? task.activatedAt
                            : task.finishedAt!
                          : app.createdAt;
                        return (
                          <tr key={item.id}>
                            <td>
                              {app.appNo}
                              <small>差旅申请</small>
                            </td>
                            <td className="travel-title-cell">
                              <strong>{app.title || "未命名差旅申请"}</strong>
                              <small>
                                {app.applicant.name} ·{" "}
                                {app.applicant.departmentName}
                              </small>
                            </td>
                            <td>
                              <span className="badge">
                                {travelStatusNames[app.status]}
                              </span>
                            </td>
                            {task && (
                              <td>
                                {task.seqNo}. {task.name}
                                <small>{taskStatusNames[task.status]}</small>
                              </td>
                            )}
                            <td>
                              {app.currentTask
                                ? `${app.currentTask.name} · ${app.currentTask.approver.name}`
                                : "—"}
                            </td>
                            <td>
                              <time>{travelTime(time)}</time>
                            </td>
                            <td>
                              <Link
                                className="text-button"
                                prefetch={false}
                                href={`/travel/${app.status === "draft" ? "drafts" : "applications"}/${app.id}`}
                              >
                                {app.status === "draft"
                                  ? "继续填写"
                                  : mode === "pending"
                                    ? "查看并审批"
                                    : "查看详情"}
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <Pager
              page={resource.data.page}
              pageSize={resource.data.pageSize}
              total={resource.data.total}
              busy={resource.loading || navigating}
              onChange={(page) => navigate({ ...input, page })}
            />
          </>
        )}
      </section>
    </div>
  );
}
