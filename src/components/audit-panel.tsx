"use client";
import { useState } from "react";
import type { UserIdentity } from "@/lib/identity";
import {
  type Department,
  type PageResult,
  roleNames,
  statusNames,
} from "@/lib/identity-display";
import { useResource } from "./use-resource";
import { Notice, Pager } from "./ui";
type Audit = {
  id: string;
  actorId: string;
  targetId: string;
  operation: string;
  before: Partial<UserIdentity> | null;
  after: Partial<UserIdentity> | null;
  reason: string;
  createdAt: string;
};
export function AuditPanel({ departments }: { departments: Department[] }) {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useResource<PageResult<Audit>>(
    `/admin/audit-logs?page=${page}&pageSize=10`,
  );
  function snapshot(value: Partial<UserIdentity> | null) {
    if (!value) return "无";
    return [
      value.fullName ?? value.username,
      value.status ? statusNames[value.status] : undefined,
      value.departmentId
        ? (departments.find((d) => d.id === value.departmentId)?.name ??
          value.departmentId)
        : "部门未确认",
      value.roles?.map((role) => roleNames[role]).join("、"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <div className="stack large-gap">
      <header className="page-heading">
        <div>
          <h2>授权变更记录</h2>
        </div>
        <button
          className="button secondary"
          onClick={reload}
          disabled={loading}
        >
          刷新记录
        </button>
      </header>
      {loading && (
        <p className="panel empty-state" role="status">
          正在加载审计记录…
        </p>
      )}
      {error && (
        <div className="stack">
          <Notice error>{error}</Notice>
          <button className="button secondary" onClick={reload}>
            重试
          </button>
        </div>
      )}
      {data && (
        <section className="panel audit-panel" aria-label="审计记录">
          {!data.items.length && <p className="empty-state">暂无审计记录</p>}
          {data.items.map((item) => (
            <article key={item.id} className="audit-item">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">
                    {item.operation === "organization.bootstrap"
                      ? "组织初始化"
                      : "用户权限变更"}
                  </p>
                  <h2>
                    {item.after?.fullName ?? item.after?.username ?? "组织配置"}
                  </h2>
                </div>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                  })}
                </time>
              </div>
              <p className="audit-reason">{item.reason}</p>
              <details>
                <summary>查看变更详情</summary>
                <dl className="detail-list">
                  <div>
                    <dt>变更前</dt>
                    <dd>{snapshot(item.before)}</dd>
                  </div>
                  <div>
                    <dt>变更后</dt>
                    <dd>{snapshot(item.after)}</dd>
                  </div>
                  <div>
                    <dt>操作者 ID</dt>
                    <dd className="mono">{item.actorId ?? "系统"}</dd>
                  </div>
                  <div>
                    <dt>目标 ID</dt>
                    <dd className="mono">{item.targetId ?? "无"}</dd>
                  </div>
                </dl>
              </details>
            </article>
          ))}
          <Pager
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            busy={loading}
            onChange={setPage}
          />
        </section>
      )}
    </div>
  );
}
