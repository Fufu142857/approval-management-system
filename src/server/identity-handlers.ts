import { z } from "zod";
import {
  accessSchema,
  loginSchema,
  pageSchema,
  registerSchema,
  userListSchema,
} from "../lib/identity";
import { changeUserAccess, listAuditLogs, listUsers } from "./admin";
import { login, logout, register, requireAdmin, requireUser } from "./auth";
import { database } from "./db";
import {
  checkOrigin,
  data,
  endpoint,
  jsonBody,
  requestToken,
  sessionCookie,
} from "./http";

export function registerHandler(request: Request) {
  return endpoint(async () => {
    checkOrigin(request, true);
    return data(await register(await jsonBody(request, registerSchema)), 201);
  });
}

export function loginHandler(request: Request) {
  return endpoint(async () => {
    checkOrigin(request, true);
    const input = await jsonBody(request, loginSchema);
    const result = await login(input.username, input.password);
    if (input.client === "mobile") return data(result);
    // Browser code never receives a token in JSON or localStorage.
    return data({ user: result.user, expiresAt: result.expiresAt }, 200, {
      "Set-Cookie": sessionCookie(result.token),
    });
  });
}

export function logoutHandler(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    await logout(requestToken(request));
    return data({ loggedOut: true }, 200, {
      "Set-Cookie": sessionCookie("", true),
    });
  });
}

export function meHandler(request: Request) {
  return endpoint(async () => data(await requireUser(requestToken(request))));
}

export function departmentsHandler() {
  return endpoint(async () =>
    data(
      (
        await database().query(
          "SELECT id,name FROM departments WHERE active ORDER BY name,id",
        )
      ).rows,
    ),
  );
}

export function rolesHandler(request: Request) {
  return endpoint(async () => {
    await requireAdmin(requestToken(request));
    return data(
      (await database().query("SELECT code,name FROM roles ORDER BY code"))
        .rows,
    );
  });
}

export function usersHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listUsers(
        requestToken(request),
        userListSchema.parse(
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
    ),
  );
}

export function auditHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listAuditLogs(
        requestToken(request),
        pageSchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
      ),
    ),
  );
}

export function accessHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    const id = z.uuid().parse((await context.params).id);
    const input = await jsonBody(request, accessSchema);
    return data(await changeUserAccess(requestToken(request), id, input));
  });
}
