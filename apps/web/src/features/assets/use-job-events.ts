import { useEffect, useRef, useState } from "react";
import { JobEventSchema, type JobEvent } from "@dmall/contracts";

export type JobStreamMode = "connecting" | "live" | "polling";

export function useJobEvents(
  jobId: string | null,
  onEvent: (event: JobEvent) => void,
): JobStreamMode {
  const handler = useRef(onEvent);
  const [mode, setMode] = useState<JobStreamMode>("connecting");

  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (jobId === null) return;
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = 0;

    const connect = () => {
      if (closed) return;
      if (typeof EventSource === "undefined") {
        setMode("polling");
        return;
      }
      setMode("connecting");
      const query = lastSeq === 0 ? "" : `?lastEventId=${lastSeq}`;
      source = new EventSource(`/api/v1/jobs/${encodeURIComponent(jobId)}/events${query}`);
      source.onopen = () => {
        if (!closed) setMode("live");
      };
      source.onmessage = (message) => {
        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
        } catch {
          return;
        }
        const parsed = JobEventSchema.safeParse(raw);
        if (!parsed.success || parsed.data.seq <= lastSeq) return;
        lastSeq = parsed.data.seq;
        handler.current(parsed.data);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        setMode("polling");
        reconnectTimer = setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    };
  }, [jobId]);

  return mode;
}
