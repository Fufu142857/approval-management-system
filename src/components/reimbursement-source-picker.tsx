"use client";
import { useState } from "react";
import type { ReimbursementLinkSummary } from "@/lib/reimbursement";
import type { PageResult } from "@/lib/identity-display";
import { useResource } from "./use-resource";
import { Field, Pager } from "./ui";
import { TravelFailure } from "./travel-common";

export function ReimbursementSourcePicker({
  selected,
  onChange,
  disabled,
}: {
  selected: ReimbursementLinkSummary[];
  onChange: (items: ReimbursementLinkSummary[]) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useResource<
    PageResult<ReimbursementLinkSummary>
  >(
    `/reimbursement-link-options?page=${page}&pageSize=5&keyword=${encodeURIComponent(keyword)}${type ? `&type=${type}` : ""}`,
  );
  return (
    <div className="stack reimbursement-sources">
      <div className="reimbursement-source-filter">
        <Field name="sourceType" label="来源类型">
          <select
            id="sourceType"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部类型</option>
            <option value="travel">差旅</option>
            <option value="purchase">采购</option>
          </select>
        </Field>
        <Field name="sourceKeyword" label="搜索已批申请">
          <input
            id="sourceKeyword"
            value={query}
            maxLength={200}
            placeholder="标题或编号"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setKeyword(query.trim());
                setPage(1);
              }
            }}
          />
        </Field>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setKeyword(query.trim());
            setPage(1);
          }}
        >
          查询来源
        </button>
      </div>
      {loading && <p role="status">正在读取本人已批申请…</p>}
      {error && <TravelFailure message={error} retry={reload} />}
      {data && (
        <>
          {!data.items.length && (
            <p className="hint">
              没有符合条件的本人已批准申请；可填写独立报销说明。
            </p>
          )}
          <ul className="reimbursement-source-list">
            {data.items.map((item) => (
              <li key={item.id}>
                <label className="purchase-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.some((value) => value.id === item.id)}
                    disabled={
                      disabled ||
                      (selected.length >= 20 &&
                        !selected.some((value) => value.id === item.id))
                    }
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, item]
                          : selected.filter((value) => value.id !== item.id),
                      )
                    }
                  />
                  <span>
                    {item.type === "travel" ? "差旅" : "采购"} · {item.appNo} ·{" "}
                    {item.title}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            busy={disabled || loading}
            onChange={setPage}
          />
        </>
      )}
      <div id="linkedApplicationIds" tabIndex={-1}>
        <h3>已选关联申请（{selected.length}/20）</h3>
        {!selected.length && <p className="hint">尚未选择关联申请</p>}
        <ul className="reimbursement-source-list">
          {selected.map((item) => (
            <li key={item.id} className="section-heading">
              <a
                href={`/${item.type}/applications/${item.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {item.type === "travel" ? "差旅" : "采购"} · {item.appNo} ·{" "}
                {item.title}
              </a>
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                aria-label={`取消关联 ${item.appNo}`}
                onClick={() =>
                  onChange(selected.filter((value) => value.id !== item.id))
                }
              >
                取消关联
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="hint">
        仅可关联本人已批准的差旅或采购；保存时会再次核验。取消关联不修改原申请。
      </p>
    </div>
  );
}
