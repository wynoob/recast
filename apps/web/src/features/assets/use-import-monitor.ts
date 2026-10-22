import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelJob, importDetailQuery, isTerminalJobState, jobQuery, retryImport } from "./api.js";
import { useJobEvents } from "./use-job-events.js";

export function useImportMonitor({ importId, jobId, csrfToken }: {
  importId: string;
  jobId: string;
  csrfToken: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const detail = useQuery({
    ...importDetailQuery(importId, cursor),
    retry: 0,
    refetchInterval: (query) => query.state.data !== undefined && isTerminalJobState(query.state.data.status) ? false : 2_000,
  });
  const job = useQuery({
    ...jobQuery(jobId),
    retry: 0,
    refetchInterval: (query) => query.state.data !== undefined && isTerminalJobState(query.state.data.state) ? false : 2_000,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["import", importId] }),
      queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
    ]);
  };
  const stream = useJobEvents(jobId, () => {
    void refresh();
  });
  const terminal = detail.data !== undefined && isTerminalJobState(detail.data.status);
  useEffect(() => {
    if (!terminal) return;
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    void queryClient.invalidateQueries({ queryKey: ["asset"] });
    void queryClient.invalidateQueries({ queryKey: ["sources"] });
  }, [terminal, queryClient]);

  const lock = useRef(false);
  const [pendingAction, setPendingAction] = useState<"cancel" | "retry" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pageFailed = detail.data?.items.filter((item) => item.state === "failed") ?? [];
  const canRetryPage = terminal && pageFailed.length > 0 && csrfToken !== undefined;
  const act = async (kind: "cancel" | "retry") => {
    if (csrfToken === undefined || lock.current || (kind === "retry" && !canRetryPage)) return;
    lock.current = true;
    setPendingAction(kind);
    setActionError(null);
    try {
      if (kind === "cancel") await cancelJob({ jobId, csrfToken });
      else await retryImport({ importId, itemIds: pageFailed.map((item) => item.id), csrfToken });
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "操作失败，请稍后重试");
    } finally {
      lock.current = false;
      setPendingAction(null);
    }
  };

  return {
    detail, job, stream, terminal, pageFailed, canRetryPage, pendingAction, actionError,
    pageNumber: cursors.length,
    hasPrevious: cursors.length > 1,
    previous: () => setCursors((history) => history.length > 1 ? history.slice(0, -1) : history),
    next: () => {
      const nextCursor = detail.data?.nextCursor;
      if (nextCursor !== undefined && nextCursor !== null) setCursors((history) => [...history, nextCursor]);
    },
    cancel: () => act("cancel"),
    retryPage: () => act("retry"),
  };
}
