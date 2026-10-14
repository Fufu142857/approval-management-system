"use client";
import { useEffect, useState } from "react";
import { api, errorMessage, handleSessionError } from "@/lib/api-client";

export function useResource<T>(path: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();
  const key = `${path}:${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    api<T>(path, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted && !handleSessionError(error))
          setResult({ key, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [path, key]);
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    loading: result?.key !== key,
    reload: () => setRevision((value) => value + 1),
  };
}
