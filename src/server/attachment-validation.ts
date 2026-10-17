import { createHash } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  attachmentNameSchema,
  maxAttachmentBytes,
  type Attachment,
} from "../lib/attachments";
import { ApiError } from "./errors";

export async function validateAttachment(
  bytes: Buffer,
  filename: string,
  declaredType: string,
) {
  const originalName = attachmentNameSchema.parse(filename);
  if (bytes.length === 0)
    throw new ApiError(400, "EMPTY_ATTACHMENT", "附件不能为空");
  if (bytes.length > maxAttachmentBytes)
    throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "单件附件不能超过 10 MiB");
  let mimeType: Attachment["mimeType"];
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mimeType = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    mimeType = "image/jpeg";
  else if (/^%PDF-(1\.[0-7]|2\.0)/.test(bytes.subarray(0, 8).toString("ascii")))
    mimeType = "application/pdf";
  else
    throw new ApiError(
      415,
      "UNSUPPORTED_ATTACHMENT",
      "仅支持真实 JPEG、PNG 或 PDF 文件",
    );
  const extension = originalName.split(".").at(-1)?.toLowerCase();
  const allowedExtensions =
    mimeType === "image/jpeg"
      ? ["jpg", "jpeg"]
      : mimeType === "image/png"
        ? ["png"]
        : ["pdf"];
  if (
    !allowedExtensions.includes(extension ?? "") ||
    (declaredType &&
      declaredType !== "application/octet-stream" &&
      declaredType !== mimeType)
  )
    throw new ApiError(
      415,
      "ATTACHMENT_TYPE_MISMATCH",
      "文件扩展名、声明类型与实际内容不一致",
    );
  try {
    if (mimeType === "application/pdf") {
      if (!/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")))
        throw Error("Missing PDF ending");
      const document = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
      if (document.getPageCount() < 1) throw Error("Empty PDF");
    } else {
      // Decode pixels, not merely the header. Bound decoded dimensions as well as file size.
      await sharp(bytes, {
        failOn: "warning",
        limitInputPixels: 40_000_000,
      }).stats();
    }
  } catch {
    throw new ApiError(
      415,
      "INVALID_ATTACHMENT",
      "文件损坏、加密或超出可解析范围；图片最多 4000 万像素",
    );
  }
  return {
    bytes,
    originalName,
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export type ValidatedAttachment = Awaited<
  ReturnType<typeof validateAttachment>
>;
