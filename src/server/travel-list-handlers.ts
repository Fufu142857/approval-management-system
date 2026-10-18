import {
  travelApplicationListSchema,
  travelTaskListSchema,
} from "../lib/travel-lists";
import { listTravelApplications, listTravelTasks } from "./travel-lists";
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
export function travelApplicationsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listTravelApplications(
        requestToken(request),
        travelApplicationListSchema.parse(query(request)),
      ),
    ),
  );
}
export function travelTasksHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listTravelTasks(
        requestToken(request),
        travelTaskListSchema.parse(query(request)),
      ),
    ),
  );
}
