import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon, useLayerFocus } from "./ui.js";

export type InspectorPreference = "expanded" | "collapsed";

const WIDE_MEDIA = "(min-width: 1101px)";
const PREFERENCE_PREFIX = "dcw.inspector.";

function preferenceKey(scope: string): string {
  return `${PREFERENCE_PREFIX}${scope}`;
}

function readPreference(scope: string): InspectorPreference {
  try {
    return window.localStorage.getItem(preferenceKey(scope)) === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

function writePreference(scope: string, value: InspectorPreference): void {
  try {
    window.localStorage.setItem(preferenceKey(scope), value);
  } catch {
  }
}

export interface InspectorController {
  narrow: boolean;
  preference: InspectorPreference;
  expanded: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export function useInspector(scope: string): InspectorController {
  const [preference, setPreference] = useState<InspectorPreference>(() => readPreference(scope));
  const [narrow, setNarrow] = useState(() => !window.matchMedia(WIDE_MEDIA).matches);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(WIDE_MEDIA);
    const sync = () => setNarrow(!media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  const persist = useCallback((next: InspectorPreference) => {
    setPreference(next);
    writePreference(scope, next);
  }, [scope]);

  const open = useCallback(() => {
    if (narrow) setDrawerOpen(true);
    else persist("expanded");
  }, [narrow, persist]);

  const close = useCallback(() => {
    if (narrow) setDrawerOpen(false);
    else persist("collapsed");
  }, [narrow, persist]);

  const toggle = useCallback(() => {
    if (narrow) setDrawerOpen((value) => !value);
    else persist(preference === "expanded" ? "collapsed" : "expanded");
  }, [narrow, preference, persist]);

  return {
    narrow,
    preference,
    expanded: narrow ? drawerOpen : preference === "expanded",
    open,
    close,
    toggle,
  };
}

export function InspectorShell({
  open,
  narrow,
  label,
  onClose,
  children,
}: {
  open: boolean;
  narrow: boolean;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  if (!narrow) return <>{children}</>;
  return <InspectorDrawer label={label} onClose={onClose}>{children}</InspectorDrawer>;
}

function InspectorDrawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayerFocus(panel, onClose);
  return createPortal(
    <div
      className="inspector-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panel} tabIndex={-1} className="inspector-drawer" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const INSPECTOR_STICKY_TOP = 72;
const INSPECTOR_VIEWPORT_GAP = 24;

function useFitInspector(panel: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = panel.current;
    if (node === null) return;
    let frame = 0;
    let applied = -1;

    const measure = () => {
      frame = 0;
      const inDrawer = node.closest(".inspector-drawer") !== null;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const top = inDrawer ? 0 : Math.max(INSPECTOR_STICKY_TOP, node.getBoundingClientRect().top);
      const gap = inDrawer ? 0 : INSPECTOR_VIEWPORT_GAP;
      const available = Math.max(0, Math.floor(viewportHeight - top - gap));
      if (available === applied) return;
      applied = available;
      node.style.maxHeight = `${available}px`;
    };

    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", schedule);
    visualViewport?.addEventListener("scroll", schedule);

    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    observer.observe(document.body);
    if (node.parentElement !== null) observer.observe(node.parentElement);
    observer.observe(node);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      observer.disconnect();
      node.style.maxHeight = "";
    };
  }, [panel]);
}

export function InspectorPanel({
  id,
  label,
  meta,
  title,
  subtitle,
  preview,
  actions,
  closeLabel,
  onClose,
  emptyTitle,
  emptyCopy,
  children,
}: {
  id: string;
  label: string;
  meta?: string | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  preview?: ReactNode;
  actions?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  emptyTitle: string;
  emptyCopy: string;
  children?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useFitInspector(panel);
  return (
    <aside id={id} ref={panel} className="inspector" aria-label={label}>
      <header className="inspector-head">
        <div>
          <strong>{label}</strong>
          <span>{meta ?? "未选择"}</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={closeLabel}>
          <Icon name="close" />
        </button>
      </header>
      {title === undefined ? (
        <div className="inspector-body">
          <div className="inspector-empty">
            <strong>{emptyTitle}</strong>
            <span>{emptyCopy}</span>
          </div>
        </div>
      ) : (
        <>
          {preview === undefined ? null : <div className="inspector-preview">{preview}</div>}
          <div className="inspector-body">
            <div className="inspector-details">
              <h2 className="inspector-title">{title}</h2>
              {subtitle === undefined ? null : <p className="inspector-subline">{subtitle}</p>}
              {children}
            </div>
            {actions === undefined ? null : <div className="inspector-actions">{actions}</div>}
          </div>
        </>
      )}
    </aside>
  );
}

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function InspectorFacts({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl className="inspector-facts">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
