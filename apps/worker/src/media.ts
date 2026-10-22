import { stat } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import type { MediaProbe } from "@dmall/contracts";
import type { MediaProcessRuntime } from "./media-process.js";
import { WorkerTaskError } from "./task-error.js";

const ProbeOutputSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.int().positive().optional(),
      height: z.int().positive().optional(),
      avg_frame_rate: z.string().optional(),
      r_frame_rate: z.string().optional(),
      nb_frames: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
  format: z.object({
    duration: z.string().optional(),
  }),
});

export interface MediaProcessingResult {
  probe: MediaProbe;
  posterPath: string;
  previewPath: string | null;
}

export async function processImage(
  sourcePath: string,
  posterPath: string,
): Promise<MediaProcessingResult> {
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "图片缺少有效尺寸");
  }
  await writePoster(sourcePath, posterPath, false);
  return {
    probe: {
      kind: "image",
      width: metadata.width,
      height: metadata.height,
      format: metadata.format ?? "unknown",
      hasAlpha: metadata.hasAlpha === true,
    },
    posterPath,
    previewPath: null,
  };
}

export async function processGif(
  sourcePath: string,
  posterPath: string,
): Promise<MediaProcessingResult> {
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "GIF 缺少有效尺寸");
  }
  const pages = metadata.pages ?? 1;
  const delays = metadata.delay ?? [];
  const durationMs =
    delays.length === 0 ? null : delays.reduce((sum, delay) => sum + delay, 0);
  await writePoster(sourcePath, posterPath, false);
  return {
    probe: {
      kind: "gif",
      width: metadata.width,
      height: metadata.height,
      pages,
      durationMs,
    },
    posterPath,
    previewPath: null,
  };
}

export async function processVideo(input: {
  sourcePath: string;
  posterPngPath: string;
  posterPath: string;
  previewPath: string;
  media: MediaProcessRuntime;
  signal: AbortSignal;
}): Promise<MediaProcessingResult> {
  const probe = await probeVideo(input.sourcePath, input.media, input.signal);
  const timestampSeconds = Math.min(1_000, Math.floor(probe.durationMs / 10)) / 1_000;
  await input.media.run({
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      timestampSeconds.toFixed(3),
      "-i",
      input.sourcePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:960:force_original_aspect_ratio=decrease",
      "-y",
      input.posterPngPath,
    ],
    signal: input.signal,
    timeoutMs: 120_000,
  });
  const posterMetadata = await sharp(input.posterPngPath).metadata();
  if ((posterMetadata.width ?? 0) <= 0 || (posterMetadata.height ?? 0) <= 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "视频封面帧不可解码");
  }
  await writePoster(input.posterPngPath, input.posterPath, false);

  const fps = finiteFps(probe.fps);
  const videoFilter = `scale=w='trunc(min(960,iw)/2)*2':h=-2:flags=lanczos,fps=${fps}`;
  const audioArguments = probe.audioCodec === null ? ["-an"] : ["-c:a", "aac", "-b:a", "96k"];
  await input.media.run({
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input.sourcePath,
      "-vf",
      videoFilter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      ...audioArguments,
      "-y",
      input.previewPath,
    ],
    signal: input.signal,
    timeoutMs: 15 * 60 * 1000,
  });
  const previewStats = await stat(input.previewPath);
  if (previewStats.size === 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "视频预览为空");
  }
  const previewProbe = await probeVideo(input.previewPath, input.media, input.signal);
  if (previewProbe.durationMs <= 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "视频预览不可解码");
  }
  return {
    probe,
    posterPath: input.posterPath,
    previewPath: input.previewPath,
  };
}

async function writePoster(sourcePath: string, destination: string, animated: boolean): Promise<void> {
  await sharp(sourcePath, { animated, pages: 1 })
    .rotate()
    .resize({
      width: 960,
      height: 960,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toFile(destination);
  const metadata = await sharp(destination).metadata();
  const stats = await stat(destination);
  if (stats.size === 0 || (metadata.width ?? 0) <= 0 || (metadata.height ?? 0) <= 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "预览图不可解码");
  }
}

async function probeVideo(
  sourcePath: string,
  media: MediaProcessRuntime,
  signal: AbortSignal,
): Promise<Extract<MediaProbe, { kind: "video" }>> {
  const result = await media.run({
    command: "ffprobe",
    args: [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      sourcePath,
    ],
    signal,
    timeoutMs: 60_000,
  });
  const parsed = ProbeOutputSchema.parse(JSON.parse(result.stdout) as unknown);
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  if (video === undefined || video.width === undefined || video.height === undefined) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "视频缺少可解码画面");
  }
  const durationSeconds = Number(parsed.format.duration ?? video.duration ?? "0");
  const durationMs = Math.round(durationSeconds * 1_000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "视频时长无效");
  }
  const fps = parseRational(video.avg_frame_rate ?? video.r_frame_rate ?? "");
  if (fps === null || fps <= 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "视频帧率无效");
  }
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  const frameCountRaw = video.nb_frames === undefined ? Number.NaN : Number(video.nb_frames);
  return {
    kind: "video",
    durationMs,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name ?? "unknown",
    fps,
    audioCodec: audio?.codec_name ?? null,
    frameCount: Number.isFinite(frameCountRaw) && frameCountRaw > 0 ? frameCountRaw : null,
  };
}

function parseRational(value: string): number | null {
  if (value === "") return null;
  const [numeratorRaw, denominatorRaw = "1"] = value.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function finiteFps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "帧率不是有限正数");
  }
  return String(Math.min(30, Math.round(value * 1_000) / 1_000));
}
