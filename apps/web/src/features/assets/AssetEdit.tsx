import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeTitle, normalizeTags } from "@dmall/domain/asset-fields";
import type { AssetDetailV2, PatchAssetRequest } from "@dmall/contracts";
import { conflictDetails, patchAsset } from "./api.js";
import { originLabel } from "./format.js";
import { ErrorLine } from "../../ui.js";

type SavePayload = Pick<PatchAssetRequest, "schemaVersion" | "expectedVersion">
  & Pick<AssetDetailV2["humanFields"], "title" | "tags">;

interface ConflictState {
  currentVersion: number;
  title: string;
  tags: string[];
  origins: { title: "source" | "manual"; tags: "source" | "manual" };
}

export function AssetEdit({ data, csrfToken, onDirtyChange }: {
  data: AssetDetailV2;
  csrfToken: string;
  onDirtyChange: (dirty: boolean, pending: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [baseline, setBaseline] = useState<{ title: string; tags: string[]; version: number } | null>(null);
  const [initialized, setInitialized] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error" | "conflict">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [titleNotice, setTitleNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const request = useRef<{ readonly payload: Readonly<SavePayload>; readonly key: string; readonly generation: number } | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  if (initialized !== data.summary.id) {
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
    if (!valid || inFlight.current || baseline === null || normalizedTags === null || conflict !== null) return;
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

  useEffect(() => { onDirtyChange(dirty, pending); }, [dirty, pending, onDirtyChange]);

  return (
    <div className="asset-edit">
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
  );
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
