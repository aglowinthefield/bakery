import type { MergeConflict } from "./model.js";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const failure = new Error(
      data.error ?? `Request failed (${response.status})`,
    ) as Error & { conflict?: MergeConflict };
    if (data.code === "merge_conflict" && Array.isArray(data.files))
      failure.conflict = data as MergeConflict;
    throw failure;
  }
  return data as T;
}
export const date = (value: string) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
