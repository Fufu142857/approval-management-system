import { z } from "zod";
import type { Attachment } from "./attachments";
export const receiptNumberSchema = z
  .string()
  .trim()
  .max(100)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    "票据号码不能包含控制字符",
  );
export type ReimbursementAttachment = Attachment & {
  itemId: string;
  receiptNumber: string;
};
