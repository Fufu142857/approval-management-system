"use client";
import Link from "next/link";
import { useState } from "react";
import type { ReimbursementDraftSummary } from "@/lib/reimbursement";
import type { PageResult } from "@/lib/identity-display";
import { travelTime } from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { Pager } from "./ui";
import { TravelFailure } from "./travel-common";

export function ReimbursementDraftsPanel() {
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useResource<
    PageResult<ReimbursementDraftSummary>
  >(
    `/reimbursement-drafts?page=${page}&pageSize=10&keyword=${encodeURIComponent(keyword)}`,
  );
  return (
    <div className="stack">
      <nav className="management-tabs" aria-label="报销草稿导航">
        <Link href="/travel/applications" prefetch={false}>
          差旅申请
        </Link>
        <Link href="/purchase/applications" prefetch={false}>
          采购申请
        </Link>
        <Link href="/reimbursement/drafts" aria-current="page" prefetch={false}>
          报销草稿
        </Link>
      </nav>
      <div className="page-heading">
        <div>
          <h2>报销草稿</h2>
          <p className="hint">尚未提交的本人报销申请</p>
        </div>
        <Link className="button" href="/reimbursement/new" prefetch={false}>
          ＋ 新建报销申请
        </Link>
      </div>
      <section className="panel table-panel" aria-label="报销草稿列表">
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
            <label htmlFor="reimbursement-search">搜索</label>
            <input
              id="reimbursement-search"
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
                    : "暂无报销草稿，点击新建开始填写"}
              </p>
            ) : (
              <>
                <p className="scroll-hint">左右滑动可查看完整列表</p>
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="报销草稿表格"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>申请编号</th>
                        <th>标题</th>
                        <th>状态</th>
                        <th>报销金额（元）</th>
                        <th>无票支出</th>
                        <th>更新时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((draft) => (
                        <tr key={draft.id}>
                          <td>{draft.appNo}</td>
                          <td className="travel-title-cell">
                            <strong>{draft.title || "未命名报销申请"}</strong>
                          </td>
                          <td>
                            <span className="badge">草稿</span>
                          </td>
                          <td>{draft.totalAmount ?? "—"}</td>
                          <td>{draft.noReceiptCount} 项</td>
                          <td>
                            <time>{travelTime(draft.updatedAt)}</time>
                          </td>
                          <td>
                            <Link
                              className="text-button"
                              href={`/reimbursement/drafts/${draft.id}`}
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
