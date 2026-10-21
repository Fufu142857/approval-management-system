"use client";
import Link from "next/link";
import {
  purchaseLink,
  type PurchaseDetail as Detail,
} from "@/lib/purchase-display";
import type { PurchaseAttachment } from "@/lib/purchase-attachments";
import {
  travelStatusNames,
  taskStatusNames,
  travelTime,
} from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { AttachmentItems, TravelFailure } from "./travel-common";
import { Notice } from "./ui";

type FileList = {
  items: PurchaseAttachment[];
  version: number;
  status: string;
};
export function PurchaseDetail({ id }: { id: string }) {
  const detail = useResource<Detail>(`/purchase-applications/${id}`);
  const files = useResource<FileList>(
    `/purchase-applications/${id}/attachments`,
  );
  const reload = () => {
    detail.reload();
    files.reload();
  };
  if (detail.error || files.error)
    return (
      <div className="stack">
        <TravelFailure message={detail.error || files.error!} retry={reload} />
        <Link href={`/purchase/drafts/${id}`}>查看本人草稿</Link>
        <Link href="/notifications">返回通知中心</Link>
      </div>
    );
  if (!detail.data || !files.data)
    return (
      <p className="empty-state" role="status">
        正在加载采购申请…
      </p>
    );
  const { application: app, workflow, tasks, logs } = detail.data;
  if (app.version !== files.data.version || app.status !== files.data.status)
    return (
      <TravelFailure
        message="读取期间申请状态已变化，请刷新后查看。"
        retry={reload}
      />
    );
  const snapshot = workflow.routeSnapshot;
  const selected = app.quotes.find(
    (quote) => quote.id === snapshot.selectedQuoteId,
  );
  const actor = (id: string) =>
    id === snapshot.applicant.id
      ? snapshot.applicant.name
      : (snapshot.steps.find((step) => step.approver.id === id)?.approver
          .name ?? "历史操作人");
  return (
    <div className="stack purchase-workspace purchase-readonly">
      <div className="section-heading">
        <div className="actions">
          <Link className="text-button" href="/purchase/drafts">
            ← 采购草稿
          </Link>
          <Link className="text-button" href="/notifications">
            通知中心
          </Link>
        </div>
        <button className="button secondary" onClick={reload}>
          刷新详情
        </button>
      </div>
      <section className="panel purchase-section">
        <div className="section-heading">
          <h2 className="travel-long-text">{app.title}</h2>
          <span className="badge">{travelStatusNames[app.status]}</span>
        </div>
        <p className="hint">
          {app.appNo} · 提交于 {travelTime(app.submittedAt)}
        </p>
        <p className="hint">
          表单与附件已冻结，可在下方查看报价、审批进度与历史记录。
        </p>
        {snapshot.singleSource && (
          <Notice>单一来源采购 · 已提交单一来源说明</Notice>
        )}
        <dl className="travel-details">
          <div>
            <dt>申请人</dt>
            <dd>{snapshot.applicant.name}</dd>
          </div>
          <div>
            <dt>申请部门</dt>
            <dd>{snapshot.applicant.departmentName}</dd>
          </div>
          <div className="travel-span">
            <dt>采购原因</dt>
            <dd>{app.reason}</dd>
          </div>
          <div>
            <dt>期望到货日期</dt>
            <dd>{app.expectedDate}</dd>
          </div>
          <div>
            <dt>所属项目</dt>
            <dd>{app.project || "—"}</dd>
          </div>
          <div>
            <dt>预算上限</dt>
            <dd>{snapshot.budgetLimit} 元</dd>
          </div>
          <div>
            <dt>预计总额</dt>
            <dd>{snapshot.totalAmount} 元</dd>
          </div>
        </dl>
      </section>
      <section className="panel purchase-section">
        <h2>采购明细</h2>
        <p className="scroll-hint">左右滑动可查看完整明细</p>
        <div
          className="table-scroll"
          role="region"
          aria-label="采购明细"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>名称</th>
                <th>规格型号</th>
                <th>数量</th>
                <th>单位</th>
                <th>单价（元）</th>
                <th>金额（元）</th>
              </tr>
            </thead>
            <tbody>
              {app.items.map((item, index) => (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>{item.name}</td>
                  <td>{item.specification}</td>
                  <td>{item.quantity}</td>
                  <td>{item.unit}</td>
                  <td>{item.unitPrice}</td>
                  <td>{item.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="purchase-total">
          预计总额：<strong>{snapshot.totalAmount} 元</strong>
        </p>
      </section>
      <section className="panel purchase-section">
        <h2>供应商报价</h2>
        <p className="scroll-hint">左右滑动可查看完整报价</p>
        <div
          className="table-scroll"
          role="region"
          aria-label="供应商报价"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>供应商名称</th>
                <th>报价日期</th>
                <th>报价金额（元）</th>
                <th>报价依据 / 明细</th>
                <th>购买链接 / 附件</th>
              </tr>
            </thead>
            <tbody>
              {app.quotes.map((quote, index) => {
                const url = purchaseLink(quote.purchaseUrl);
                return (
                  <tr key={quote.id}>
                    <td>
                      {quote.supplierName}
                      {quote.id === snapshot.selectedQuoteId && (
                        <span className="badge">拟选供应商</span>
                      )}
                    </td>
                    <td>{quote.quoteDate}</td>
                    <td>{quote.amount ?? "未填金额"}</td>
                    <td className="travel-long-text">
                      {quote.basis || "见报价附件"}
                    </td>
                    <td>
                      <span className="badge">
                        {quote.isOnline ? "线上报价" : "线下报价"}
                      </span>
                      {url && (
                        <a
                          className="text-button"
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          查看购买链接（新窗口）
                        </a>
                      )}
                      <a
                        className="text-button"
                        href={`#quote-files-${quote.id}`}
                      >
                        查看报价 {index + 1} 附件（
                        {
                          files.data!.items.filter(
                            (file) => file.quoteId === quote.id,
                          ).length
                        }
                        ）
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <div className="purchase-choice-grid">
        <section className="panel purchase-section">
          <h2>采购选择</h2>
          <dl className="travel-details">
            <div className="travel-span">
              <dt>拟选供应商</dt>
              <dd>
                {selected?.supplierName ?? "—"} ·{" "}
                {snapshot.selectedQuoteAmount === null
                  ? "未填金额"
                  : `${snapshot.selectedQuoteAmount} 元`}
              </dd>
            </div>
            <div className="travel-span">
              <dt>比价结果</dt>
              <dd>
                {!snapshot.priceComparisonComplete ||
                snapshot.selectedNotLowest === null
                  ? "部分报价未填金额，无法判断最低价"
                  : snapshot.selectedNotLowest
                    ? "未选最低报价"
                    : "已选最低报价（含并列）"}
                {snapshot.lowestQuoteAmount !== null && (
                  <p>最低报价：{snapshot.lowestQuoteAmount} 元</p>
                )}
              </dd>
            </div>
            <div className="travel-span">
              <dt>选择原因</dt>
              <dd>{snapshot.selectionReason}</dd>
            </div>
          </dl>
        </section>
        <section className="panel purchase-section">
          <h2>单一来源说明（如适用）</h2>
          <dl className="travel-details">
            <div className="travel-span">
              <dt>采购方式</dt>
              <dd>{snapshot.singleSource ? "单一来源采购" : "多供应商比价"}</dd>
            </div>
            <div className="travel-span">
              <dt>单一来源原因</dt>
              <dd>{snapshot.singleSourceReason || "不适用"}</dd>
            </div>
          </dl>
        </section>
      </div>
      <section className="panel purchase-section">
        <h2>报价附件</h2>
        {app.quotes.map((quote, index) => (
          <div
            key={quote.id}
            id={`quote-files-${quote.id}`}
            className="purchase-file-group"
          >
            <h3>
              报价 {index + 1} · {quote.supplierName}
            </h3>
            <AttachmentItems
              appId={id}
              resource="purchase-applications"
              items={files.data!.items.filter(
                (file) => file.quoteId === quote.id,
              )}
            />
          </div>
        ))}
      </section>
      <section className="panel purchase-section">
        <h2>审批进度</h2>
        <p className="hint">部门负责人 → 企业负责人 · 提交时确定的实际人员</p>
        <ol className="travel-timeline">
          {tasks.map((task) => (
            <li key={task.id}>
              <div className="section-heading">
                <strong>
                  {task.seqNo}. {task.name} · {actor(task.approverId)}
                </strong>
                <span className="badge">{taskStatusNames[task.status]}</span>
              </div>
              <p className="hint">
                {task.status === "cancelled"
                  ? `${task.activatedAt ? "已取消" : "已取消，未开始"} · 取消时间：${task.finishedAt ? travelTime(task.finishedAt) : "—"}`
                  : task.finishedAt
                    ? `处理时间：${travelTime(task.finishedAt)}`
                    : task.activatedAt
                      ? `开始时间：${travelTime(task.activatedAt)}`
                      : "前一节点通过后开始"}
              </p>
            </li>
          ))}
        </ol>
      </section>
      <section className="panel purchase-section">
        <h2>历史记录</h2>
        <ol className="travel-timeline">
          {logs.map((log) => (
            <li key={log.id}>
              <div className="section-heading">
                <strong>
                  {actor(log.actorId)} ·{" "}
                  {
                    {
                      submitted: "提交申请",
                      approved: "批准",
                      rejected: "驳回",
                      withdrawn: "撤回",
                    }[log.action]
                  }
                </strong>
                <time>{travelTime(log.createdAt)}</time>
              </div>
              <p className="hint">
                处理结果：{travelStatusNames[log.result]} · 申请版本{" "}
                {log.applicationVersion}
              </p>
              {log.opinion && <p className="travel-long-text">{log.opinion}</p>}
            </li>
          ))}
        </ol>
      </section>
      {app.remarks && (
        <section className="panel purchase-section">
          <h2>备注</h2>
          <p className="travel-long-text">{app.remarks}</p>
        </section>
      )}
    </div>
  );
}
