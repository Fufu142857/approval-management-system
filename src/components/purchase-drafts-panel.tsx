"use client";
import Link from "next/link";
import { useState } from "react";
import type { PurchaseDraftSummary } from "@/lib/purchase";
import type { PageResult } from "@/lib/identity-display";
import { travelTime } from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { Pager } from "./ui";
import { TravelFailure } from "./travel-common";

export function PurchaseDraftsPanel() {
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useResource<
    PageResult<PurchaseDraftSummary>
  >(
    `/purchase-drafts?page=${page}&pageSize=10&keyword=${encodeURIComponent(keyword)}`,
  );
  return (
    <div className="stack">
      <nav className="management-tabs" aria-label="申请导航">
        <Link href="/travel/applications">差旅申请</Link>
        <Link href="/purchase/drafts" aria-current="page">
          采购草稿
        </Link>
      </nav>
      <div className="page-heading">
        <div>
          <h2>采购草稿</h2>
          <p className="hint">尚未提交的本人采购申请</p>
        </div>
        <Link className="button" href="/purchase/new" prefetch={false}>
          ＋ 新建采购申请
        </Link>
      </div>
      <section className="panel table-panel" aria-label="采购草稿列表">
        <div className="table-toolbar travel-toolbar">
          <form
            className="filter"
            method="get"
            onSubmit={(event) => {
              event.preventDefault();
              setKeyword(query.trim());
              setPage(1);
            }}
          >
            <label htmlFor="purchase-search">搜索</label>
            <input
              id="purchase-search"
              value={query}
              maxLength={200}
              placeholder="申请标题或编号"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="button secondary" type="submit">
              查询
            </button>
          </form>
          <button
            className="button secondary"
            onClick={reload}
            disabled={loading}
          >
            刷新列表
          </button>
        </div>
        {loading && (
          <p role="status" className="empty-state">
            正在加载草稿…
          </p>
        )}
        {error && <TravelFailure message={error} retry={reload} />}
        {data && (
          <>
            {!data.items.length ? (
              <p className="empty-state">
                {data.total
                  ? "本页没有草稿，请返回上一页"
                  : keyword
                    ? "没有符合条件的草稿"
                    : "暂无采购草稿，点击新建开始填写"}
              </p>
            ) : (
              <>
                <p className="scroll-hint">左右滑动可查看完整列表</p>
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="采购草稿表格"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>申请编号</th>
                        <th>标题</th>
                        <th>状态</th>
                        <th>预算 / 预计总额（元）</th>
                        <th>更新时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((draft) => (
                        <tr key={draft.id}>
                          <td>{draft.appNo}</td>
                          <td className="travel-title-cell">
                            <strong>{draft.title || "未命名采购申请"}</strong>
                          </td>
                          <td>
                            <span className="badge">草稿</span>
                          </td>
                          <td>
                            {draft.budgetLimit ?? "—"} /{" "}
                            {draft.totalAmount ?? "—"}
                          </td>
                          <td>
                            <time>{travelTime(draft.updatedAt)}</time>
                          </td>
                          <td>
                            <Link
                              className="text-button"
                              href={`/purchase/drafts/${draft.id}`}
                              prefetch={false}
                            >
                              继续填写
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <Pager
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              busy={loading}
              onChange={setPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
