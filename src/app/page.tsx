export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16 sm:px-10">
      <p className="mb-5 text-sm font-medium tracking-wide text-neutral-500">
        B/S 体系软件设计
      </p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        审批管理系统
      </h1>
      <p className="mt-5 max-w-xl text-base leading-8 text-neutral-600">
        项目已完成工程初始化。账号、申请与审批功能将在后续开发阶段逐步开放。
      </p>
      <div className="mt-10 rounded-xl border border-neutral-200 bg-white px-6 py-5">
        <p className="font-medium">当前进度：工程基础</p>
        <p className="mt-2 text-sm leading-7 text-neutral-600">
          下一阶段将接入数据库，完成账号登录与部门权限管理。
        </p>
      </div>
    </main>
  );
}
