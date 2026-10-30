import { useRef, useState } from "react";
import type { AssetDetailV2 } from "@dmall/contracts";
import "./asset-media.css";

export interface AssetMediaProps {
  data: AssetDetailV2;
}

interface DragPosition {
  pointerId: number;
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
}

export function AssetMedia({ data }: AssetMediaProps) {
  return <MediaViewer key={`${data.summary.id}:${data.summary.originalFileUrl}`} data={data} />;
}

function MediaViewer({ data }: AssetMediaProps) {
  const { summary } = data;
  const [scale, setScale] = useState<"fit" | "actual">("fit");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<DragPosition | null>(null);
  const video = summary.mediaKind === "video";

  function fit() {
    setScale("fit");
    drag.current = null;
    stage.current?.scrollTo({ left: 0, top: 0 });
  }

  return (
    <section className="asset-media" aria-label="素材原件">
      <div
        ref={stage}
        className={`asset-media-stage${!video && scale === "actual" ? " asset-media-stage-actual" : ""}`}
        tabIndex={0}
        aria-label={video ? "原件视频" : "原件图片，100% 时可滚动或拖动查看"}
        onPointerDown={(event) => {
          if (video || scale !== "actual" || failed || event.button !== 0 || !event.isPrimary) return;
          const element = event.currentTarget;
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            scrollLeft: element.scrollLeft,
            scrollTop: element.scrollTop,
          };
          element.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.scrollLeft + start.x - event.clientX;
          event.currentTarget.scrollTop = start.scrollTop + start.y - event.clientY;
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          drag.current = null;
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
      >
        {summary.originalFileUrl === null || failed ? (
          <div className="asset-media-error" role="alert">
            <p>{summary.originalFileUrl === null ? "原件不可用" : "原件暂时无法读取"}</p>
            {summary.originalFileUrl === null ? null : (
              <button className="asset-media-button" type="button" onClick={() => {
                setFailed(false);
                setAttempt((value) => value + 1);
              }}>重试</button>
            )}
          </div>
        ) : video ? (
          <video
            key={attempt}
            controls
            playsInline
            preload="metadata"
            src={summary.originalFileUrl}
            poster={summary.posterFileUrl ?? undefined}
            aria-label={`${summary.title}完整原件`}
            data-testid="asset-video"
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            key={attempt}
            src={summary.originalFileUrl}
            alt={summary.title}
            draggable={false}
            data-testid={summary.mediaKind === "gif" ? "asset-gif" : "asset-image"}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <div className="asset-media-controls">
        <p>{video ? "完整原件 · 可播放和拖动进度" : summary.mediaKind === "gif" ? "原始 GIF · 保持动画" : "原始图片"}</p>
        {video ? null : (
          <div className="asset-media-scale" role="group" aria-label="图片缩放">
            <button className="asset-media-button" type="button" aria-pressed={scale === "fit"} onClick={fit}>适应窗口</button>
            <button className="asset-media-button" type="button" aria-pressed={scale === "actual"} onClick={() => setScale("actual")}>100%</button>
          </div>
        )}
      </div>
    </section>
  );
}
