import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeTitle, normalizeTags } from "@dmall/domain/asset-fields";
import type { AssetDetailV2, AssetOccurrenceView, PatchAssetRequest } from "@dmall/contracts";
import { assetDetailQuery, conflictDetails, patchAsset } from "./api.js";
import {
  formatBytes,
  formatDimensions,
  formatDurationMs,
  mediaKindLabel,
  mediaStatusLabel,
  originLabel,
  probeSummary,
} from "./format.js";
import { locatorDetails, rawTarget, SourceContextPanel } from "./SourceContext.js";
import { Dialog, ErrorLine, Icon, LoadingLine } from "../../ui.js";

type SavePayload = Pick<PatchAssetRequest, "schemaVersion" | "expectedVersion">
  & Pick<AssetDetailV2["humanFields"], "title" | "tags">;

interface ConflictState {
  currentVersion: number;
  title: string;
  tags: string[];
  origins: { title: "source" | "manual"; tags: "source" | "manual" };
}

export function AssetDetailDrawer({
  assetId,
  csrfToken,
  onClose,
}: {
  assetId: string;
  csrfToken: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery(assetDetailQuery(assetId));
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [baseline, setBaseline] = useState<{ title: string; tags: string[]; version: number } | null>(null);
  const [initialized, setInitialized] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error" | "conflict">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [titleNotice, setTitleNotice] = useState<string | null>(null);
  const [sourcePanel, setSourcePanel] = useState<{
    sourceId: string;
    versionId: string;
    occurrences: AssetOccurrenceView[];
  } | null>(null);
  const generation = useRef(0);
  const request = useRef<{ readonly payload: Readonly<SavePayload>; readonly key: string; readonly generation: number } | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const data = detail.data;
  if (data !== undefined && initialized !== data.summary.id) {
    const suggestionTitle =
      data.humanFields.origins.title === "source" ? data.sourceSuggestion?.title ?? null : null;
    setInitialized(data.summary.id);
    setTitle(suggestionTitle ?? data.humanFields.title);
    setTagsText(data.humanFields.tags.join(", "));
    setBaseline({ title: data.humanFields.title, tags: data.humanFields.tags, version: data.summary.version });
    setTitleNotice(
      suggestionTitle !== null
        ? "说明文档提供了标题，已预填。保存后才会采用。"
        : data.humanFields.origins.title === "source" && data.sourceSuggestion !== null
          ? "说明文档没有标题，继续使用文件名。"
          : null,
    );
    setSaveState("idle");
  }

  const normalizedTitle = normalizeTitle(title);
  const normalizedTags = parseTags(tagsText);
  const valid = normalizedTitle !== "" && [...normalizedTitle].length <= 200 && normalizedTags !== null;
  const dirty = baseline !== null && (normalizedTitle !== baseline.title || normalizedTags === null || !sameTags(normalizedTags, baseline.tags));

  const save = async () => {
    if (!valid || inFlight.current || data === undefined || baseline === null || normalizedTags === null || conflict !== null) return;
    const payload: SavePayload = { schemaVersion: 1, expectedVersion: baseline.version, title: normalizedTitle, tags: normalizedTags };
    if (request.current === null || JSON.stringify(request.current.payload) !== JSON.stringify(payload)) {
      request.current = Object.freeze({ payload: Object.freeze(payload), key: crypto.randomUUID(), generation: generation.current });
    }
    const attempt = request.current;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await patchAsset({
        id: data.summary.id,
        ...attempt.payload,
        csrfToken,
        idempotencyKey: attempt.key,
      });
      request.current = null;
      setBaseline({ title: result.title, tags: result.tags, version: result.version });
      if (generation.current === attempt.generation) {
        setTitle(result.title);
        setTagsText(result.tags.join(", "));
        setSaveState("saved");
        setNotice(`已保存为新版本（第 ${result.version + 1} 版）。`);
      } else {
        setSaveState("idle");
        setNotice(`已保存第 ${result.version + 1} 版，后续输入尚未保存。`);
      }
      await queryClient.invalidateQueries({ queryKey: ["asset", data.summary.id] });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    } catch (reason) {
      const latest = conflictDetails(reason);
      if (latest === null) {
        setSaveState("error");
        setError(reason instanceof Error ? reason.message : "保存失败，请稍后重试");
      } else {
        setSaveState("conflict");
        setConflict(latest);
        setError(null);
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const adoptLatest = () => {
    if (conflict === null) return;
    setTitle(conflict.title);
    setTagsText(conflict.tags.join(", "));
    setBaseline({ title: conflict.title, tags: conflict.tags, version: conflict.currentVersion });
    setConflict(null);
    setSaveState("idle");
    request.current = null;
    setNotice("已载入最新版本，输入已替换为最新值。");
  };

  const keepMine = () => {
    if (conflict === null) return;
    setBaseline({ title: conflict.title, tags: conflict.tags, version: conflict.currentVersion });
    setConflict(null);
    setSaveState("idle");
    request.current = null;
    setNotice("已采用最新版本号。请再次点击保存，才会以你的输入创建新版本。");
  };

  return (
    <Dialog
      title={data?.summary.title ?? "素材详情"}
      subtitle="原件、预览、来源和每次出现位置。标题与标签保存为新版本。"
      onClose={onClose}
      wide
    >
      {detail.isLoading ? <LoadingLine label="正在打开素材" /> : null}
      {detail.isError ? <ErrorLine message={detail.error.message} /> : null}
      {data === undefined ? null : (
        <>
          <div className="asset-detail-layout">
            <Preview data={data} />
            <div className="asset-edit">
              <div className="asset-kicker">
                <span className="kind-pill">{mediaKindLabel(data.summary.mediaKind)}</span>
                <span className={`state-pill ${data.summary.availability === "available" ? "ready" : "draft"}`}>
                  {data.summary.availability === "available" ? "原件与预览可用" : "需要补齐"}
                </span>
                <span className="soft-pill">第 {data.summary.version + 1} 版</span>
              </div>
              <label className="field">
                <span>标题 · {originLabel(data.humanFields.origins.title)}</span>
                <input
                  value={title}
                  onChange={(event) => { generation.current += 1; setTitle(event.target.value); setTitleNotice(null); setSaveState("idle"); setNotice(null); }}
                />
              </label>
              {titleNotice === null ? null : <p className="section-note title-note">{titleNotice}</p>}
              <label className="field">
                <span>标签 · 逗号分隔 · {originLabel(data.humanFields.origins.tags)}</span>
                <input
                  value={tagsText}
                  onChange={(event) => { generation.current += 1; setTagsText(event.target.value); setSaveState("idle"); setNotice(null); }}
                  placeholder="例如：经营诊断, 昨日销量"
                />
              </label>
              <div className="save-line">
                <button
                  className="button primary"
                  type="button"
                  onClick={() => { void save(); }}
                  disabled={!valid || !dirty || pending || conflict !== null}
                >
                  {pending ? "保存中…" : "保存修改"}
                </button>
                <span className="muted small">
                  {saveState === "saved" ? "已保存" : saveState === "conflict" ? "有冲突" : "保存会创建新版本"}
                </span>
              </div>
              {notice === null ? null : <div className="inline-success" role="status">{notice}</div>}
              {error === null ? null : <ErrorLine message={error} />}
              {conflict === null ? null : (
                <div className="conflict-box" role="alert">
                  <b>素材已被另一处修改，已载入最新版本。</b>
                  <p>你输入的内容仍保留，没有自动覆盖另一处修改。</p>
                  <dl>
                    <div><dt>最新标题</dt><dd>{conflict.title}</dd></div>
                    <div><dt>最新标签</dt><dd>{conflict.tags.length === 0 ? "无" : conflict.tags.join("、")}</dd></div>
                    <div><dt>最新版本</dt><dd>第 {conflict.currentVersion + 1} 版</dd></div>
                  </dl>
                  <div className="dialog-actions wrap">
                    <button className="button" type="button" onClick={adoptLatest}>载入最新版本</button>
                    <button className="button primary" type="button" onClick={keepMine}>保留我的输入</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <section className="drawer-section">
            <div className="panel-title-row">
              <h3>文件信息</h3>
              <span className="soft-pill">{data.summary.mime}</span>
            </div>
            <dl className="detail-list two-column">
              <div><dt>大小</dt><dd>{formatBytes(data.summary.bytes)}</dd></div>
              <div><dt>尺寸</dt><dd>{formatDimensions(data.summary.width, data.summary.height)}</dd></div>
              <div><dt>时长</dt><dd>{formatDurationMs(data.summary.durationMs)}</dd></div>
              <div><dt>媒体信息</dt><dd>{probeSummary(data.metadata.probe)}</dd></div>
              <div><dt>来源数量</dt><dd>{data.summary.sourceCount}</dd></div>
              <div><dt>出现位置</dt><dd>{data.summary.occurrenceCount}</dd></div>
            </dl>
            {data.metadata.extensionMismatch ? (
              <div className="notice warn"><Icon name="alert" /><div><b>扩展名与真实格式不一致。</b><br />系统按文件内容识别为 {data.metadata.magicMime}。</div></div>
            ) : null}
          </section>

          <section className="drawer-section">
            <div className="panel-title-row">
              <h3>来源与出现位置</h3>
              <span className="soft-pill">{data.occurrences.length} 处</span>
            </div>
            {data.occurrences.length === 0 ? <p className="section-note">这条素材还没有来源位置。</p> : null}
            <div className="occurrence-list">
              {groupOccurrences(data.occurrences).map((group) => {
                const first = group.items[0];
                if (first === undefined) return null;
                return (
                  <article className="occurrence" key={group.key}>
                    <div className="occurrence-head">
                      <h4>{first.sourceTitle === "" ? "未知来源" : first.sourceTitle}</h4>
                      <span className={`state-pill ${groupMissing(group.items) ? "draft" : "ready"}`}>
                        {groupMissing(group.items) ? `${group.items.filter((item) => item.mediaStatus === "missing").length} 处缺失` : "可用"}
                      </span>
                    </div>
                    <p className="section-note">{first.sourceRelativePath} · {group.items.length} 个位置</p>
                    {group.items.map((occurrence) => (
                      <div className="occurrence-line" key={occurrence.id}>
                        <b>{occurrence.headingPath === "" ? "未分章节" : occurrence.headingPath}</b>
                        <span className="muted small">{mediaStatusLabel(occurrence.mediaStatus)}</span>
                        <span className="raw-target">{rawTarget(occurrence)} · {locatorDetails(occurrence)}</span>
                      </div>
                    ))}
                    <button
                      className="button small"
                      type="button"
                      onClick={() => setSourcePanel({
                        sourceId: first.sourceId,
                        versionId: first.sourceVersionId,
                        occurrences: group.items,
                      })}
                    >
                      <Icon name="source" />
                      查看来源上下文
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          {data.sourceSuggestion === null ? null : (
            <SourceSuggestionSection
              suggestion={data.sourceSuggestion}
              onOpenSource={(sourceId, versionId) => setSourcePanel({ sourceId, versionId, occurrences: [] })}
            />
          )}

          <div className="notice warn">
            <Icon name="info" />
            <div><b>文字识别未配置。</b><br />当前不显示识别文本。视频可播放，图片与动图使用真实原件或预览。</div>
          </div>
          <div className="dialog-actions">
            <button className="button" type="button" onClick={onClose}>关闭</button>
          </div>
        </>
      )}
      {sourcePanel === null ? null : (
        <SourceContextPanel
          occurrences={sourcePanel.occurrences}
          sourceId={sourcePanel.sourceId}
          versionId={sourcePanel.versionId}
          onClose={() => setSourcePanel(null)}
        />
      )}
    </Dialog>
  );
}

function Preview({ data }: { data: AssetDetailV2 }) {
  const { summary } = data;
  if (summary.originalFileUrl === null) {
    return (
      <div className="asset-preview missing">
        <Icon name="alert" />
        <span>原件不可用</span>
      </div>
    );
  }
  if (summary.mediaKind === "video") {
    return (
      <div className="asset-preview">
        <video
          controls
          playsInline
          preload="metadata"
          src={summary.originalFileUrl}
          poster={summary.posterFileUrl ?? undefined}
          data-testid="asset-video"
        />
        <span className="preview-caption">原件播放 · 支持拖动进度</span>
      </div>
    );
  }
  return (
    <div className="asset-preview">
      <img
        src={summary.originalFileUrl}
        alt={summary.title}
        loading="lazy"
        data-testid={summary.mediaKind === "gif" ? "asset-gif" : "asset-image"}
      />
      <span className="preview-caption">{summary.mediaKind === "gif" ? "原始 GIF · 保持动画" : "原始图片"}</span>
    </div>
  );
}

function SourceSuggestionSection({
  suggestion,
  onOpenSource,
}: {
  suggestion: NonNullable<AssetDetailV2["sourceSuggestion"]>;
  onOpenSource: (sourceId: string, versionId: string) => void;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <section className="drawer-section suggestion-section">
      <div className="panel-title-row">
        <h3>使用说明</h3>
        <span className="soft-pill">来源建议</span>
      </div>
      <p className="suggestion-source">
        {suggestion.provenance.sourceTitle} · {suggestion.provenance.sourceRelativePath}
        <span>
          File {suggestion.provenance.fileCell} · 版本 {suggestion.provenance.sourceVersionId.slice(0, 12)}
        </span>
        <span>
          第 {suggestion.provenance.lineStart}–{suggestion.provenance.lineEnd} 行
          {suggestion.provenance.sectionHeading === "" ? "" : ` · ${suggestion.provenance.sectionHeading}`}
        </span>
      </p>
      <p className="usage-text">{suggestion.usageText}</p>
      {suggestion.ignoredSuggestionCount === 0 ? null : (
        <p className="section-note">另有 {suggestion.ignoredSuggestionCount} 条说明未用于本素材。</p>
      )}
      <div className="dialog-actions wrap">
        <button
          className="button small"
          type="button"
          onClick={() => onOpenSource(suggestion.provenance.sourceId, suggestion.provenance.sourceVersionId)}
        >
          <Icon name="source" />
          打开来源
        </button>
        <button className="button small" type="button" aria-expanded={rawOpen} onClick={() => setRawOpen((value) => !value)}>
          {rawOpen ? "收起原文" : "查看原文"}
        </button>
      </div>
      {rawOpen ? <pre className="usage-raw">{suggestion.usageMarkdown}</pre> : null}
    </section>
  );
}

function groupOccurrences(occurrences: AssetOccurrenceView[]): Array<{ key: string; items: AssetOccurrenceView[] }> {
  const groups = new Map<string, AssetOccurrenceView[]>();
  for (const occurrence of occurrences) {
    const key = occurrence.sourceVersionId;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [occurrence]);
    else list.push(occurrence);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function groupMissing(items: AssetOccurrenceView[]): boolean {
  return items.some((item) => item.mediaStatus === "missing" || item.mediaStatus === "unsupported");
}

function parseTags(value: string): string[] | null {
  try {
    return normalizeTags(value.split(/[,，]/u)).display;
  } catch {
    return null;
  }
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}
