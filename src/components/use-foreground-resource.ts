"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  handleSessionError,
  RequestError,
} from "@/lib/api-client";

// One read at a time, scheduled after completion; hidden/unmounted readers are cancelled.
export function useForegroundResource<T>(
  path: string,
  enabled: boolean,
  redirectForbidden = true,
) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    path: string;
    data?: T;
    error?: string;
    updatedAt?: string;
  }>();
  const stopped = useRef(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled || stopped.current) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: AbortController | undefined;
    async function read() {
      if (
        disposed ||
        stopped.current ||
        document.visibilityState !== "visible" ||
        current
      )
        return;
      clearTimeout(timer);
      const controller = new AbortController();
      current = controller;
      try {
        const data = await api<T>(path, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (!disposed && !controller.signal.aborted)
          setResult({ path, data, updatedAt: new Date().toISOString() });
      } catch (failure) {
        if (!disposed && !controller.signal.aborted) {
          const denied =
            failure instanceof RequestError &&
            [401, 403].includes(failure.status);
          if (denied) {
            stopped.current = true;
            setResult({ path, error: errorMessage(failure) });
            if (failure.status === 401 || redirectForbidden)
              handleSessionError(failure);
          } else {
            setResult((previous) => ({
              ...(previous?.path === path ? previous : {}),
              path,
              error: errorMessage(failure),
            }));
          }
        }
      } finally {
        if (current === controller) current = undefined;
        if (
          !disposed &&
          !controller.signal.aborted &&
          !stopped.current &&
          document.visibilityState === "visible"
        )
          timer = setTimeout(read, 30000);
      }
    }
    function visibility() {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") {
        current?.abort();
        current = undefined;
      } else void read();
    }
    void read();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      current?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [path, enabled, redirectForbidden, revision]);
  const matching = result?.path === path ? result : undefined;
  return {
    data: enabled ? matching?.data : undefined,
    error: matching?.error,
    updatedAt: matching?.updatedAt,
    refresh,
  };
}
