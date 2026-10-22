import { LocalAdapterError, type ExtractionLimits } from "./contracts.js";

export class ExtractionBudget {
  private textChars = 0;
  private mediaFiles = 0;

  constructor(private readonly limits: ExtractionLimits) {}

  reserveText(text: string): void {
    const next = this.textChars + text.length;
    if (next > this.limits.maxTextCharsPerDocument) {
      throw new LocalAdapterError("CAPACITY_EXCEEDED", "文档文本超过容量上限", {
        details: { textChars: next, maxTextCharsPerDocument: this.limits.maxTextCharsPerDocument },
      });
    }
    this.textChars = next;
  }

  reserveMedia(count = 1): void {
    const next = this.mediaFiles + count;
    if (next > this.limits.maxMediaFiles) {
      throw new LocalAdapterError("CAPACITY_EXCEEDED", "文档媒体数量超过容量上限", {
        details: { mediaFiles: next, maxMediaFiles: this.limits.maxMediaFiles },
      });
    }
    this.mediaFiles = next;
  }
}
