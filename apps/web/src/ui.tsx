import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type IconName =
  | "doc"
  | "slide"
  | "history"
  | "settings"
  | "folder"
  | "file"
  | "image"
  | "video"
  | "gif"
  | "check"
  | "alert"
  | "close"
  | "lock"
  | "info"
  | "upload"
  | "source"
  | "refresh"
  | "assets"
  | "template"
  | "content"
  | "plus"
  | "search"
  | "chevron"
  | "filter"
  | "edit"
  | "download"
  | "play";

const focusLayers: Array<{ panel: RefObject<HTMLElement | null> }> = [];
const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";
let originalOverflow = "";

export function useLayerFocus(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = { panel };
    if (focusLayers.length === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    focusLayers.push(layer);
    const nodes = () => [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0 && node.closest("[inert]") === null);
    const focusFirst = () => {
      const current = document.activeElement;
      if (
        current instanceof HTMLElement &&
        current !== panel.current &&
        panel.current?.contains(current) === true
      ) {
        return;
      }
      const preferred = panel.current?.querySelector<HTMLElement>(
        "[data-autofocus], input[autofocus], textarea[autofocus], select[autofocus]",
      );
      (preferred ?? nodes()[0] ?? panel.current)?.focus();
    };
    focusFirst();
    const onKey = (event: KeyboardEvent) => {
      if (focusLayers[focusLayers.length - 1] !== layer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const available = nodes();
      const first = available[0];
      const last = available[available.length - 1];
      const outside = !available.some((node) => node === document.activeElement);
      if (outside || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        (event.shiftKey ? last : first)?.focus();
        if (available.length === 0) panel.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const index = focusLayers.indexOf(layer);
      const wasTop = index === focusLayers.length - 1;
      if (index !== -1) focusLayers.splice(index, 1);
      if (focusLayers.length === 0) document.body.style.overflow = originalOverflow;
      const top = focusLayers[focusLayers.length - 1];
      if (wasTop && previous?.isConnected && (top === undefined || top.panel.current?.contains(previous))) previous.focus();
    };
  }, [panel]);
}

export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  extraWide = false,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  extraWide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  useLayerFocus(panel, onClose);

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={panel}
        tabIndex={-1}
        className={`dialog-panel${wide ? " wide" : ""}${extraWide ? " extra-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

export function LoadingLine({ label }: { label: string }) {
  return <div className="loading-line"><span className="spinner" />{label}…</div>;
}

export function ErrorLine({ message }: { message: string }) {
  return <div className="inline-error" role="alert">{message}</div>;
}

export function StatusRow({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "muted";
}) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <span className={`status-value ${tone}`}>{value}</span>
    </div>
  );
}

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    doc: <><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M9.5 2.5V5H12M6 7.2h4M6 9.4h4M6 11.6h2.8" /></>,
    slide: <><rect x="2" y="3" width="12" height="8.5" rx="1.2" /><path d="M8 11.5V14M5.8 14h4.4M4.7 6.4h6.6M4.7 8.6h4.2" /></>,
    history: <><path d="M3.2 5.3A5.5 5.5 0 1 1 2.7 9" /><path d="M3 2.8v2.8h2.8M8 5v3.2l2.2 1.3" /></>,
    settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 2.2v1.5M8 12.3v1.5M13.8 8h-1.5M3.7 8H2.2M12.1 3.9l-1.1 1.1M5 11l-1.1 1.1M12.1 12.1 11 11M5 5 3.9 3.9" /></>,
    folder: <><path d="M2.2 4.4h4l1.2 1.5h6.4v6.7H2.2z" /><path d="M2.2 6h11.6" /></>,
    file: <><path d="M4 2.4h5.2L12 5.2v8.4H4z" /><path d="M9.2 2.4v2.8H12" /></>,
    image: <><rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.5" /><circle cx="6" cy="6.4" r="1" /><path d="m3.4 11.4 3-3 2.4 2.2 1.7-1.6 2.1 2.4" /></>,
    video: <><rect x="2.2" y="4" width="8.4" height="8" rx="1.4" /><path d="m10.6 6.6 3-1.7v6.2l-3-1.7z" /></>,
    gif: <><rect x="2.2" y="3.6" width="11.6" height="8.8" rx="1.5" /><path d="M6.3 6.5c-.9 0-1.5.7-1.5 1.5s.6 1.5 1.5 1.5c.7 0 1.2-.4 1.4-1H6.4M8.4 6.5v3M10.1 9.5v-3h2" /></>,
    check: <><path d="m3.2 8.4 3 3 6.6-6.8" /></>,
    alert: <><path d="M8 2.6 14 13H2z" /><path d="M8 6.2v3.2M8 11.3v.2" /></>,
    close: <><path d="m4 4 8 8M12 4l-8 8" /></>,
    lock: <><rect x="3.2" y="6.7" width="9.6" height="6.5" rx="1.4" /><path d="M5.4 6.7V5.2a2.6 2.6 0 0 1 5.2 0v1.5" /></>,
    info: <><circle cx="8" cy="8" r="5.6" /><path d="M8 7.1v3.4M8 5.4v.2" /></>,
    upload: <><path d="M8 10.8V3.2M5.2 6l2.8-2.8L10.8 6M3 11.2v1.6h10v-1.6" /></>,
    source: <><path d="M3 4.2h4.2l1.1 1.3H13v6.3H3z" /><path d="M6 8.2h4M6 10.2h3" /></>,
    refresh: <><path d="M12.6 5.1A5.2 5.2 0 1 0 13 9.4" /><path d="M13 2.8v2.7h-2.7" /></>,
    assets: <><rect x="2.2" y="3" width="11.6" height="10" rx="1.4" /><path d="M2.2 6.2h11.6M5.6 3v3.2" /></>,
    template: <><rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.3" /><path d="M2.2 5.8h11.6M6.3 5.8v7.4" /></>,
    content: <><path d="M4 2.4h5.2L12 5.2v8.4H4z" /><path d="M9.2 2.4v2.8H12M6 7.4h4M6 9.6h4M6 11.6h2.6" /></>,
    plus: <><path d="M8 3.2v9.6M3.2 8h9.6" /></>,
    search: <><circle cx="7.2" cy="7.2" r="4.2" /><path d="m10.4 10.4 2.8 2.8" /></>,
    chevron: <><path d="m6 3.5 4.5 4.5L6 12.5" /></>,
    filter: <><path d="M2.6 3.4h10.8L9.2 8.2v4.2l-2.4 1.2V8.2z" /></>,
    edit: <><path d="M3 13h2.4l7-7-2.4-2.4-7 7z" /><path d="m9.6 3.2 2.4 2.4" /></>,
    download: <><path d="M8 2.8v7.4M5.2 7.4 8 10.2l2.8-2.8M3 12.4h10" /></>,
    play: <><path d="M5.2 3.4 12 8l-6.8 4.6z" /></>,
  };
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
