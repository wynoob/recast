import { useQuery } from "@tanstack/react-query";
import type { AssetDetailV2, SourceContext } from "@dmall/contracts";
import { sourceContextQuery } from "./api.js";
import { rawTarget } from "./SourceContext.js";
import { mediaStatusLabel } from "./format.js";
import "./asset-media.css";

export type AssetSourceOccurrence = AssetDetailV2["occurrences"][number];
export type AssetSourceProvenance = NonNullable<AssetDetailV2["sourceSuggestion"]>["provenance"];

export interface AssetSourcesProps {
  data: AssetDetailV2;
  onShowOccurrence: (occurrence: AssetSourceOccurrence) => void;
  onShowSource: (sourceId: AssetSourceProvenance["sourceId"], versionId: AssetSourceProvenance["sourceVersionId"]) => void;
}

export interface AssetDocumentExcerptProps {
  occurrence: AssetSourceOccurrence;
  onBack: () => void;
  posterUrl: AssetDetailV2["summary"]["posterFileUrl"];
  title: AssetDetailV2["summary"]["title"];
}

export interface AssetSourceDocumentProps {
  sourceId: SourceContext["source"]["id"];
  versionId: SourceContext["version"]["id"] | null;
  onBack: () => void;
}

export function AssetSources({ data, onShowOccurrence, onShowSource }: AssetSourcesProps) {
  const local = data.occurrences.filter((occurrence) => occurrence.locator.kind === "local_file");
  const documents = data.occurrences.filter((occurrence) => occurrence.locator.kind !== "local_file");
  const suggestion = data.sourceSuggestion;

  return (
    <div className="asset-sources" aria-label="素材来源">
      {local.map((occurrence) => {
        const path = occurrence.sourceRelativePath || rawTarget(occurrence);
        const filename = path.split(/[\\/]/u).pop() || path;
        return (
          <section className="asset-sources-piece" key={occurrence.id}>
            <h3 className="asset-sources-label">导入位置</h3>
            <p className="asset-sources-filename" title={filename}>{filename}</p>
            <details>
              <summary>完整路径</summary>
              <code className="asset-sources-path">{path}</code>
            </details>
          </section>
        );
      })}
      {documents.map((occurrence) => (
        <section className="asset-sources-piece" key={occurrence.id}>
          <h3 className="asset-sources-label">所在文档</h3>
          <h4>{occurrence.sourceTitle}</h4>
          {occurrence.headingPath === "" ? null : <p>{occurrence.headingPath}</p>}
          <p>{locatorLabel(occurrence.locator)}</p>
          <button className="asset-sources-button" type="button" onClick={() => onShowOccurrence(occurrence)}>查看文档片段</button>
        </section>
      ))}
      {suggestion === null ? null : (
        <section className="asset-sources-piece">
          <h3 className="asset-sources-label">使用说明依据</h3>
          <h4>{suggestion.provenance.sourceTitle}</h4>
          {suggestion.provenance.sectionHeading === "" ? null : <p>{suggestion.provenance.sectionHeading}</p>}
          <p>第 {suggestion.provenance.lineStart}–{suggestion.provenance.lineEnd} 行</p>
          <p className="asset-sources-text">{suggestion.usageText}</p>
          <details>
            <summary>原始说明与出处</summary>
            <pre className="asset-sources-raw">{suggestion.usageMarkdown}</pre>
            <p>文件：{suggestion.provenance.fileCell}</p>
            <code className="asset-sources-path">{suggestion.provenance.sourceRelativePath}</code>
            <p>来源版本：{suggestion.provenance.sourceVersionId}</p>
          </details>
          <button className="asset-sources-button" type="button" onClick={() => onShowSource(suggestion.provenance.sourceId, suggestion.provenance.sourceVersionId)}>查看来源文档</button>
        </section>
      )}
      {local.length === 0 && documents.length === 0 && suggestion === null ? <p>暂无来源记录。</p> : null}
    </div>
  );
}

export function AssetDocumentExcerpt({ occurrence, onBack, posterUrl, title }: AssetDocumentExcerptProps) {
  return (
    <section className="asset-source-document asset-document-excerpt" aria-label="文档片段">
      <button className="asset-sources-button" type="button" onClick={onBack}>返回素材预览</button>
      <article className="asset-source-paper">
        <p className="asset-sources-label">{occurrence.sourceTitle}</p>
        {occurrence.headingPath === "" ? null : <h2>{occurrence.headingPath}</h2>}
        <OccurrenceExcerpt occurrence={occurrence} posterUrl={posterUrl} title={title} />
      </article>
    </section>
  );
}

function OccurrenceExcerpt({ occurrence, posterUrl, title }: Pick<AssetDocumentExcerptProps, "occurrence" | "posterUrl" | "title">) {
  return (
    <>
      {occurrence.beforeText === "" ? null : <p className="asset-sources-text">{occurrence.beforeText}</p>}
      <figure className="asset-source-position">
        {posterUrl === null ? null : <img src={posterUrl} alt={`${title}在文档中的位置`} loading="lazy" />}
        <figcaption>{title} · {locatorLabel(occurrence.locator)}</figcaption>
        <code className="asset-sources-path">{rawTarget(occurrence)}</code>
      </figure>
      {occurrence.afterText === "" ? null : <p className="asset-sources-text">{occurrence.afterText}</p>}
    </>
  );
}

export function AssetSourceDocument({ sourceId, versionId, onBack }: AssetSourceDocumentProps) {
  const query = useQuery(sourceContextQuery(sourceId, versionId ?? undefined));
  const source = query.data;

  return (
    <section className="asset-source-document" aria-label="来源文档">
      <button className="asset-sources-button" type="button" onClick={onBack}>返回素材预览</button>
      {query.isPending ? <p role="status">正在读取来源文档…</p> : null}
      {query.isError ? (
        <div className="asset-source-error" role="alert">
          <p>来源文档暂时无法读取。</p>
          <button className="asset-sources-button" type="button" onClick={() => { void query.refetch(); }}>重试</button>
        </div>
      ) : null}
      {source === undefined ? null : (
        <article className="asset-source-paper">
          <header className="asset-source-header">
            <p className="asset-sources-label">来源文档</p>
            <h2>{source.source.title}</h2>
            <p>来源版本 {source.version.fingerprint.slice(0, 12)} · {new Date(source.version.capturedAt).toLocaleString("zh-CN")}</p>
            <a className="asset-sources-button" href={source.version.fileUrl} target="_blank" rel="noreferrer">打开来源文件</a>
          </header>
          {source.document === null ? null : (
            <div className="asset-source-content">
              {source.document.snapshot.status === "complete" ? null : <p className="asset-source-warning">{source.document.snapshot.status === "partial" ? "文档仅完成部分抽取。" : "文档抽取受阻。"}</p>}
              {source.document.snapshot.warnings.map((warning, index) => <p className="asset-source-warning" key={index}>{warning.message}</p>)}
              {source.document.sections.map((section) => (
                <section className="asset-source-section" key={section.id}>
                  {section.title === "" ? null : <h3>{section.title}</h3>}
                  {section.headingPath === "" || section.headingPath === section.title ? null : <p className="asset-sources-label">{section.headingPath}</p>}
                  <p className="asset-sources-label">{locatorLabel(section.locator)}</p>
                  {section.blocks.length === 0 ? (section.text === "" ? null : <p className="asset-sources-text">{section.text}</p>) : section.blocks.map((block) => (
                    <p className="asset-sources-text" key={block.id}>{block.text}</p>
                  ))}
                  {section.notes === "" ? null : <p className="asset-sources-text">{section.notes}</p>}
                </section>
              ))}
            </div>
          )}
          {source.occurrences.length === 0 ? null : (
            <section className="asset-source-occurrences" aria-label="文档中的素材位置">
              <h3>素材出现位置</h3>
              {source.occurrences.map((occurrence) => (
                <section className="asset-source-section" key={occurrence.id}>
                  {occurrence.headingPath === "" ? null : <h4>{occurrence.headingPath}</h4>}
                  <p className="asset-sources-label">{mediaStatusLabel(occurrence.mediaStatus)}</p>
                  <OccurrenceExcerpt occurrence={occurrence} posterUrl={null} title="媒体位置" />
                  {occurrence.errorCode === null ? null : <p className="asset-source-warning">{occurrence.errorCode}</p>}
                </section>
              ))}
            </section>
          )}
        </article>
      )}
    </section>
  );
}

function locatorLabel(locator: AssetSourceOccurrence["locator"]): string {
  switch (locator.kind) {
    case "local_file": return locator.relativePath;
    case "markdown": return `第 ${locator.line} 行，第 ${locator.column} 列，第 ${locator.ordinal + 1} 个图片来源`;
    case "markdown_text": return `第 ${locator.line} 行，第 ${locator.column} 列`;
    case "page": return `第 ${locator.page} 页`;
    case "dom": return locator.domPath;
    case "block": return `正文块 ${locator.blockId}`;
    case "time": return `${locator.startMs}–${locator.endMs} 毫秒`;
    default: {
      const exhaustive: never = locator;
      return exhaustive;
    }
  }
}
