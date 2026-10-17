import { z } from "zod";
export const maxAttachmentBytes = 10 * 1024 * 1024;
export const maxApplicationAttachmentBytes = 50 * 1024 * 1024;
export const maxAttachments = 9;
export const attachmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(
    (name) => !/[\p{Cc}\p{Cf}/\\]/u.test(name) && name !== "." && name !== "..",
    "文件名不能包含路径或控制字符",
  );
export const attachmentContentQuery = z.strictObject({
  disposition: z.enum(["inline", "attachment"]).default("attachment"),
});
export const emptyAttachmentQuery = z.strictObject({});
export type Attachment = {
  id: string;
  appId: string;
  uploaderId: string;
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};
