/**
 * Volcengine (火山方舟) Seedream 文生图 Provider
 *
 * 调用火山方舟（Volcengine Ark）图片生成 API，仅支持文生图（Seedream 4.0–5.0、Seedream 3.0）。
 *
 * 文档链接：
 * - Seedream 4.0-5.0 教程：https://www.volcengine.com/docs/82379/1824121
 * - Seedream 3.0 教程：https://www.volcengine.com/docs/82379/1824692
 * - 图片生成 API（size 与推荐尺寸）：https://www.volcengine.com/docs/82379/1541523
 * - 模型列表：https://www.volcengine.com/docs/82379/1330310
 *
 * size 约束（文档 1541523）：直接宽高时总像素 3,686,400–10,404,496，宽高比 1/16–16；
 * 也可用分辨率关键词 2K、3K（不支持 1K、4K）。默认 2048x2048。
 */

import type { CliArgs } from "../types";

/**
 * 文生图（t2i）支持的 Seedream 模型 ID（与接入点 ep-xxx 二选一，以控制台/文档为准）
 * - 5.0 / 4.5 / 4.0：见 Seedream 4.0-5.0 教程（1824121）
 * - 3.0：见 Seedream 3.0 教程（1824692）
 * @see https://www.volcengine.com/docs/82379/1330310
 */
export const VOLCENGINE_IMAGE_MODEL_IDS = [
  "doubao-seedream-5-0-260128",
  "doubao-seedream-5-0-lite-260128",
  "doubao-seedream-4-5-251128",
  "doubao-seedream-4-0-250828",
] as const;

/** 默认模型：优先使用 5.0 系列；也可配置为接入点 ID（ep-xxx） */
const DEFAULT_MODEL = "doubao-seedream-5-0-260128";

/**
 * 返回当前默认模型：环境变量 VOLC_IMAGE_MODEL / ARK_IMAGE_MODEL 或内置默认（见 VOLCENGINE_IMAGE_MODEL_IDS）
 */
export function getDefaultModel(): string {
  return process.env.VOLC_IMAGE_MODEL || process.env.ARK_IMAGE_MODEL || DEFAULT_MODEL;
}

/**
 * 获取 API Key，优先 VOLC_API_KEY，其次 ARK_API_KEY
 */
function getApiKey(): string | null {
  return process.env.VOLC_API_KEY || process.env.ARK_API_KEY || null;
}

/**
 * 获取 Base URL，用于拼接图片生成接口路径
 */
function getBaseUrl(): string {
  const base =
    process.env.VOLC_BASE_URL ||
    process.env.ARK_BASE_URL ||
    "https://api.ark.volcengine.com/api/v3";
  return base.replace(/\/+$/g, "");
}

function parseAspectRatio(ar: string): { width: number; height: number } | null {
  const match = ar.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const w = parseFloat(match[1]!);
  const h = parseFloat(match[2]!);
  if (w <= 0 || h <= 0) return null;
  return { width: w, height: h };
}

/**
 * 文档 1541523 推荐尺寸：直接宽高时总像素 3,686,400–10,404,496，宽高比 1/16–16。
 * 2K 推荐：1:1 2048×2048，16:9 2848×1600；4:3/3:4、16:9/9:16 用下列在范围内的 [宽,高]。
 */
const STANDARD_SIZES: [number, number][] = [
  [2048, 2048],   // 1:1, 4,194,304
  [2848, 1600],   // 16:9 2K
  [1600, 2848],   // 9:16
  [2304, 1728],   // 4:3
  [1728, 2304],   // 3:4
  [2560, 1440],   // 16:9
  [1440, 2560],   // 9:16
];

/** 2K 档与文档推荐一致（同上表，normal 与 2k 共用符合文档的尺寸集） */
const STANDARD_SIZES_2K: [number, number][] = [
  [2048, 2048],
  [2848, 1600],
  [1600, 2848],
  [2304, 1728],
  [1728, 2304],
  [2560, 1440],
  [1440, 2560],
];

/**
 * 3K 档（文档 1541523：3K 1:1 → 3072×3072，3K 16:9 → 4096×2304），供后续扩展 quality 使用
 */
const STANDARD_SIZES_3K: [number, number][] = [
  [3072, 3072],
  [4096, 2304],
  [2304, 4096],
];

/**
 * 根据宽高比与 quality 在文档推荐尺寸中选最接近的 size（格式 宽x高，文档默认 2048x2048）
 */
function getSizeFromAspectRatio(ar: string | null, quality: CliArgs["quality"]): string {
  const is2k = quality === "2k";
  const defaultSize = "2048x2048";

  if (!ar) return defaultSize;

  const parsed = parseAspectRatio(ar);
  if (!parsed) return defaultSize;

  const targetRatio = parsed.width / parsed.height;
  const sizes = is2k ? STANDARD_SIZES_2K : STANDARD_SIZES;

  let best = defaultSize;
  let bestDiff = Infinity;

  for (const [w, h] of sizes) {
    const diff = Math.abs(w / h - targetRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = `${w}x${h}`;
    }
  }

  return best;
}

/** 将用户输入的 1024*1024 转为 API 要求的 1024x1024 */
function normalizeSize(size: string): string {
  return size.replace(/\*/g, "x");
}

/**
 * 火山方舟图片生成 API 响应（OpenAI 兼容格式）
 */
type VolcengineImageResponse = {
  data?: Array<{ url?: string; b64_json?: string }>;
};

/**
 * 调用火山方舟图片生成 API，返回生成图片的二进制数据
 *
 * @param prompt - 文本提示词
 * @param model - 模型 ID（见 VOLCENGINE_IMAGE_MODEL_IDS，或方舟接入点 ID ep-xxx）
 * @param args - CLI 参数（含 size/quality/aspectRatio、referenceImages 等）
 * @returns 图片二进制 Uint8Array
 * @throws 未配置 API Key 或接口报错时抛出
 */
export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs
): Promise<Uint8Array> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "VOLC_API_KEY or ARK_API_KEY is required for Volcengine provider. Set one of them in env or .baoyu-skills/.env."
    );
  }

  if (args.referenceImages.length > 0) {
    throw new Error(
      "Reference images are not supported with Volcengine provider in baoyu-image-gen. Use --provider google with a Gemini multimodal model."
    );
  }

  const size = args.size
    ? normalizeSize(args.size)
    : getSizeFromAspectRatio(args.aspectRatio, args.quality);

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/images/generations`;

  const body = {
    model,
    prompt,
    size,
    n: args.n ?? 1,
  };

  console.log(`Generating image with Volcengine (${model})...`, { size });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Volcengine/Ark API error (${res.status}): ${err}`);
  }

  const result = (await res.json()) as VolcengineImageResponse;

  const img = result.data?.[0];
  if (!img) {
    console.error("Response:", JSON.stringify(result, null, 2));
    throw new Error("No image in Volcengine response");
  }

  if (img.b64_json) {
    return Uint8Array.from(Buffer.from(img.b64_json, "base64"));
  }

  if (img.url) {
    const imgRes = await fetch(img.url);
    if (!imgRes.ok) throw new Error("Failed to download image from Volcengine URL");
    const buf = await imgRes.arrayBuffer();
    return new Uint8Array(buf);
  }

  throw new Error("No image URL or b64_json in Volcengine response");
}
