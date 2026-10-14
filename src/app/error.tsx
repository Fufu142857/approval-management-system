"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="error-page" role="alert">
      <h1>暂时无法加载页面</h1>
      <p>请检查网络连接后重试。如果问题持续，请联系管理员。</p>
      <button className="button" onClick={reset}>
        重新加载
      </button>
    </div>
  );
}
