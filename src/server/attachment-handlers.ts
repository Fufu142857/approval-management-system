import { z } from "zod";
import {
  attachmentContentQuery,
  emptyAttachmentQuery,
} from "../lib/attachments";
import { draftVersionSchema } from "../lib/travel";
import { attachmentForm, attachmentResponse } from "./attachment-http";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  authorizeAttachmentUpload,
  uploadTravelAttachment,
  listTravelAttachments,
  deleteTravelAttachment,
  getTravelAttachmentContent,
} from "./travel-attachments";

type Context = { params: Promise<{ id: string; attachmentId?: string }> };
const query = (request: Request) =>
  Object.fromEntries(new URL(request.url).searchParams);
export function uploadAttachmentHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const id = z.uuid().parse((await context.params).id);
    const token = requestToken(request);
    await authorizeAttachmentUpload(token, id);
    const { file, version } = await attachmentForm(request);
    return data(
      await uploadTravelAttachment(
        token,
        id,
        version,
        Buffer.from(await file.arrayBuffer()),
        file.name,
        file.type,
      ),
      201,
    );
  });
}
export function attachmentsHandler(request: Request, context: Context) {
  return endpoint(async () => {
    emptyAttachmentQuery.parse(query(request));
    return data(
      await listTravelAttachments(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function deleteAttachmentHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyAttachmentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(
      await deleteTravelAttachment(
        requestToken(request),
        id,
        attachmentId,
        version,
      ),
    );
  });
}
export function attachmentContentHandler(request: Request, context: Context) {
  return endpoint(async () => {
    const { disposition } = attachmentContentQuery.parse(query(request));
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const attachmentId = z.uuid().parse(params.attachmentId);
    const { attachment, bytes } = await getTravelAttachmentContent(
      requestToken(request),
      id,
      attachmentId,
    );
    return attachmentResponse(attachment, bytes, disposition);
  });
}
