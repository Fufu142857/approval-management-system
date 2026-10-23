"use client";
import Link from "next/link";
import {
  reimbursementCategoryNames,
  type ReimbursementDetail as Detail,
} from "@/lib/reimbursement-display";
import type { ReimbursementAttachment } from "@/lib/reimbursement-attachments";
import {
  travelStatusNames,
  taskStatusNames,
  travelTime,
} from "@/lib/travel-display";
import { useResource } from "./use-resource";
import { AttachmentItems, TravelFailure } from "./travel-common";
import { Notice } from "./ui";

type FileList = {
  items: ReimbursementAttachment[];
  version: number;
  status: string;
};
export function ReimbursementDetail({ id }: { id: string }) {
  const detail = useResource<Detail>(`/reimbursement-applications/${id}`);
  const files = useResource<FileList>(
    `/reimbursement-applications/${id}/attachments`,
  );
  const reload = () => {
    detail.reload();
    files.reload();
  };
  if (detail.error || files.error)
    return (
      <div className="stack">
        <TravelFailure message={detail.error || files.error!} retry={reload} />
        <Link href="/reimbursement/drafts">返回报销草稿</Link>
        <Link href="/notifications">返回通知中心</Link>
      </div>
    );
  if (!detail.data || !files.data)
    return (
      <p className="empty-state" role="status">
        正在加载报销申请…
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
  const actor = (actorId: string) =>
    actorId === snapshot.applicant.id
      ? snapshot.applicant.name
      : (snapshot.steps.find((step) => step.approver.id === actorId)?.approver
          .name ?? "历史操作人");
  return (
    <div className="stack purchase-workspace purchase-readonly reimbursement-workspace">
      <div className="section-heading">
        <div className="actions">
          <Link className="text-button" href="/reimbursement/drafts">
            ← 返回报销草稿
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
          费用、关联来源与票据已冻结。审批进度与历史记录可在下方查看。
        </p>
        {!!snapshot.noReceiptItems.length && (
          <Notice>
            无票支出 {snapshot.noReceiptItems.length} 项 ·
            请重点核对费用及无票原因
          </Notice>
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
          <div>
            <dt>报销总额</dt>
            <dd>{snapshot.totalAmount} 元</dd>
          </div>
          <div>
            <dt>无票支出</dt>
            <dd>{snapshot.noReceiptItems.length} 项</dd>
          </div>
          <div className="travel-span">
            <dt>报销说明</dt>
            <dd>{app.description}</dd>
          </div>
        </dl>
      </section>
      <section className="panel purchase-section" aria-label="关联来源">
        <h2>关联申请 / 独立报销</h2>
        <p className="hint">
          以下为提交时保存的来源摘要。报销阅读权限不包含原申请全文或附件。
        </p>
        {snapshot.linkedApplications.length ? (
          snapshot.linkedApplications.map((source) => (
            <div className="purchase-file-group" key={source.id}>
              <h3 className="travel-long-text">
                {source.type === "travel" ? "差旅" : "采购"} · {source.appNo} ·{" "}
                {source.title}
              </h3>
              <p className="hint">
                提交时状态：已通过 · 源单提交于 {travelTime(source.submittedAt)}
              </p>
              <dl className="travel-details">
                {source.travel && (
                  <>
                    <div>
                      <dt>出发地 → 目的地</dt>
                      <dd>
                        {source.travel.departure} → {source.travel.destination}
                      </dd>
                    </div>
                    <div>
                      <dt>出差日期</dt>
                      <dd>
                        {source.travel.startDate} 至 {source.travel.endDate}（
                        {source.travel.durationDays} 天）
                      </dd>
                    </div>
                    <div>
                      <dt>差旅预算</dt>
                      <dd>{source.travel.budget} 元</dd>
                    </div>
                  </>
                )}
                {source.purchase && (
                  <>
                    <div>
                      <dt>采购预算上限</dt>
                      <dd>{source.purchase.budgetLimit} 元</dd>
                    </div>
                    <div>
                      <dt>采购预计总额</dt>
                      <dd>{source.purchase.totalAmount} 元</dd>
                    </div>
                  </>
                )}
              </dl>
            </div>
          ))
        ) : (
          <p>未关联申请，独立报销。</p>
        )}
        {snapshot.independentReason && (
          <dl className="travel-details">
            <div className="travel-span">
              <dt>独立报销说明</dt>
              <dd>{snapshot.independentReason}</dd>
            </div>
          </dl>
        )}
      </section>
      <section className="panel purchase-section">
        <h2>费用明细</h2>
        <p className="scroll-hint">左右滑动可查看完整费用</p>
        <div
          className="table-scroll"
          role="region"
          aria-label="费用明细"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>费用类型</th>
                <th>发生日期</th>
                <th>用途</th>
                <th>金额（元）</th>
                <th>票据 / 无票说明</th>
              </tr>
            </thead>
            <tbody>
              {app.items.map((item, index) => (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>
                    {item.category
                      ? reimbursementCategoryNames[item.category]
                      : "—"}
                  </td>
                  <td>{item.expenseDate}</td>
                  <td className="travel-long-text">{item.purpose}</td>
                  <td>{item.amount}</td>
                  <td>
                    {item.noReceipt && (
                      <>
                        <span className="badge">无票支出</span>
                        <p className="travel-long-text">
                          {item.noReceiptReason}
                        </p>
                      </>
                    )}
                    {!item.noReceipt && item.noReceiptReason && (
                      <p className="hint">
                        保留说明（未声明无票）：{item.noReceiptReason}
                      </p>
                    )}
                    <a
                      className="text-button"
                      href={`#receipt-files-${item.id}`}
                    >
                      查看费用 {index + 1} 票据（
                      {
                        files.data!.items.filter(
                          (file) => file.itemId === item.id,
                        ).length
                      }
                      ）
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="purchase-total">
          报销总额：<strong>{snapshot.totalAmount} 元</strong>
        </p>
      </section>
      <section className="panel purchase-section">
        <h2>票据附件</h2>
        {app.items.map((item, index) => {
          const receipts = files.data!.items.filter(
            (file) => file.itemId === item.id,
          );
          return (
            <div
              key={item.id}
              id={`receipt-files-${item.id}`}
              className="purchase-file-group"
            >
              <h3 className="travel-long-text">
                费用 {index + 1} · {item.purpose}
              </h3>
              {item.noReceipt && (
                <p className="hint">
                  已声明无票：{item.noReceiptReason}
                  {receipts.length ? "；另有附加文件，无票声明仍保留。" : ""}
                </p>
              )}
              {!receipts.length && <p className="hint">本费用无上传票据。</p>}
              {receipts.map((file) => (
                <div key={file.id} className="reimbursement-receipt">
                  <p className="hint">
                    票据号码：{file.receiptNumber || "未填写"}
                  </p>
                  <AttachmentItems
                    appId={id}
                    resource="reimbursement-applications"
                    items={[file]}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </section>
      <section className="panel purchase-section">
        <h2>审批进度</h2>
        <p className="hint">部门负责人 → 财务审批人 · 提交时确定的实际人员</p>
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
