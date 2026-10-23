import {
  reimbursementApplicationListSchema,
  reimbursementTaskListSchema,
} from "../lib/reimbursement-lists";
import {
  listReimbursementApplications,
  listReimbursementTasks,
} from "./reimbursement-lists";
import { ApiError } from "./errors";
import { data, endpoint, requestToken } from "./http";

function query(request: Request) {
  const params = new URL(request.url).searchParams;
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key))
      throw new ApiError(400, "VALIDATION_ERROR", "查询参数不能重复");
    result[key] = value;
  }
  return result;
}
export function reimbursementApplicationsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listReimbursementApplications(
        requestToken(request),
        reimbursementApplicationListSchema.parse(query(request)),
      ),
    ),
  );
}
export function reimbursementTasksHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listReimbursementTasks(
        requestToken(request),
        reimbursementTaskListSchema.parse(query(request)),
      ),
    ),
  );
}
