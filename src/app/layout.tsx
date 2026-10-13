import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "审批管理系统",
  description: "企业审批系统 · B/S 课程作业",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
