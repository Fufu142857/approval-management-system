import {
  purchaseApplicationListSchema,
  purchaseTaskListSchema,
} from "../lib/purchase-lists";
import { listPurchaseApplications, listPurchaseTasks } from "./purchase-lists";
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
export function purchaseApplicationsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listPurchaseApplications(
        requestToken(request),
        purchaseApplicationListSchema.parse(query(request)),
      ),
    ),
  );
}
export function purchaseTasksHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listPurchaseTasks(
        requestToken(request),
        purchaseTaskListSchema.parse(query(request)),
      ),
    ),
  );
}
