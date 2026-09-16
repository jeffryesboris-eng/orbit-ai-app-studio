import { NextRequest, NextResponse } from "next/server";

import {
  generationRequestSchema,
  type GenerationError,
  type GenerationResponse,
} from "@/lib/generation-contract";
import { InvalidGeneratedAppError, validateGeneratedApp } from "@/lib/html-safety";

export const runtime = "nodejs";
// Leave a small margin above the upstream timeout so Vercel can return our
// structured timeout response instead of terminating the function first.
export const maxDuration = 60;

const REQUEST_BODY_LIMIT = 220_000;
const MODEL_RESPONSE_LIMIT = 200_000;
const MODEL_TIMEOUT_MS = 55_000;
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;

type RateBucket = { count: number; resetAt: number };
type ModelResponse = {
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};
type ChatModelResponse = { choices?: Array<{ message?: { content?: string } }> };

const rateBuckets = new Map<string, RateBucket>();

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "html"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },
    summary: { type: "string", minLength: 1, maxLength: 240 },
    html: { type: "string", minLength: 300, maxLength: 120_000 },
  },
};

const instructions = `你是 Orbit 的网页应用生成引擎。根据用户需求创建或修改一个可直接运行的单文件网页应用。

约束：
- 输出完整的 HTML5 文档，CSS 和 JavaScript 必须全部内联。
- 只使用原生 HTML、CSS、JavaScript，不加载任何包、字体、图片、脚本或其他外部资源。
- 不使用 fetch、XMLHttpRequest、WebSocket、EventSource、iframe、object、embed 或页面跳转。
- 应用必须有真实可操作的交互，例如添加、删除、筛选、计算、切换或表单反馈。
- 使用中文界面，兼顾桌面和手机，提供清晰焦点样式、足够对比度和空状态。
- 不编造无法运行的服务端功能。数据只保存在当前预览内存中。
- 修改现有应用时保留原有有效功能，只实现用户这次要求的变化。
- title 是简短产品名；summary 用一句中文说明本次完成的功能。`;

function jsonError(status: number, error: GenerationError["error"], headers?: HeadersInit) {
  return NextResponse.json<GenerationError>({ ok: false, error }, { status, headers });
}

function getClientKey(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "local";
}

function consumeRateLimit(key: string) {
  const now = Date.now();
  const existing = rateBuckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
    : existing;

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (rateBuckets.size > 2_000) {
    for (const [storedKey, storedBucket] of rateBuckets) {
      if (storedBucket.resetAt <= now) rateBuckets.delete(storedKey);
    }
  }

  return {
    allowed: bucket.count <= RATE_LIMIT_MAX_REQUESTS,
    remaining: Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count),
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
  };
}

function resolveEndpoint(model: string, useChatJson: boolean) {
  const configured = process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "");
  const baseUrl = configured || (model.startsWith("deepseek-") ? "https://api.deepseek.com" : "https://api.openai.com");
  const path = useChatJson ? "chat/completions" : "responses";
  return baseUrl.endsWith("/v1") ? `${baseUrl}/${path}` : `${baseUrl}/v1/${path}`;
}

function extractOutputTexts(response: ModelResponse) {
  const texts = response.output
    ?.flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text as string) || [];
  if (typeof response.output_text === "string" && response.output_text.trim()) texts.unshift(response.output_text);
  return [...new Set(texts.filter((text) => text.trim()))];
}

function parseStructuredOutput(outputText: string) {
  const trimmed = outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
      } catch {
        // Fall through to the normalized validation error below.
      }
    }
    throw new InvalidGeneratedAppError("模型返回的结构化内容无法解析");
  }
}

function parseModelOutput(candidates: string[]) {
  for (const candidate of [...candidates].reverse()) {
    try {
      return parseStructuredOutput(candidate);
    } catch {
      // Some compatible providers emit a preamble and the JSON as separate items.
    }
  }
  if (candidates.length > 1) return parseStructuredOutput(candidates.join(""));
  throw new InvalidGeneratedAppError("模型返回的结构化内容无法解析");
}

function buildUserInput(prompt: string, currentApp?: { title: string; summary: string; html: string }) {
  if (!currentApp) return `创建一个新应用。\n\n用户需求：\n${prompt}`;
  return `修改下面的现有应用。\n\n本次修改需求：\n${prompt}\n\n现有标题：${currentApp.title}\n现有摘要：${currentApp.summary}\n现有 HTML：\n${currentApp.html}`;
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > REQUEST_BODY_LIMIT) {
    return jsonError(413, { code: "REQUEST_TOO_LARGE", message: "请求内容过大，请缩短需求或新建项目。", retryable: false });
  }

  const limit = consumeRateLimit(getClientKey(request));
  const limitHeaders = {
    "X-RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
    "X-RateLimit-Remaining": String(limit.remaining),
  };
  if (!limit.allowed) {
    return jsonError(429, {
      code: "RATE_LIMITED",
      message: `请求过于频繁，请在 ${limit.retryAfter} 秒后重试。`,
      retryable: true,
      retryAfter: limit.retryAfter,
    }, { ...limitHeaders, "Retry-After": String(limit.retryAfter) });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: "INVALID_JSON", message: "请求格式无效。", retryable: false }, limitHeaders);
  }

  const parsedRequest = generationRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    return jsonError(400, { code: "INVALID_REQUEST", message: "需求需为 3–2000 个字符，当前应用代码不能超过 120 KB。", retryable: false }, limitHeaders);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) {
    return jsonError(503, { code: "MODEL_NOT_CONFIGURED", message: "服务端尚未配置模型，请检查环境变量。", retryable: false }, limitHeaders);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const useChatJson = process.env.MODEL_API_STYLE === "chat-completions" || model.startsWith("deepseek-");
    const userInput = buildUserInput(parsedRequest.data.prompt, parsedRequest.data.currentApp);
    const requestBody: Record<string, unknown> = useChatJson
      ? {
          model,
          messages: [
            {
              role: "system",
              content: `${instructions}\n\n只返回一个有效 JSON 对象，不要使用 Markdown 代码块或添加说明。JSON 必须且只能包含 title、summary、html 三个字符串字段，HTML 中的换行和引号必须正确转义。`,
            },
            { role: "user", content: userInput },
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          max_tokens: 14_000,
        }
      : {
          model,
          store: false,
          instructions,
          input: userInput,
          max_output_tokens: 14_000,
          text: {
            format: {
              type: "json_schema",
              name: "generated_web_app",
              strict: true,
              schema: outputSchema,
            },
          },
        };

    const upstream = await fetch(resolveEndpoint(model, useChatJson), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      cache: "no-store",
      signal: controller.signal,
    });

    const responseText = await upstream.text();
    if (responseText.length > MODEL_RESPONSE_LIMIT) {
      throw new InvalidGeneratedAppError("模型响应超过大小限制");
    }

    if (!upstream.ok) {
      console.error("Model request failed", { status: upstream.status, model });
      const retryable = upstream.status === 429 || upstream.status >= 500;
      return jsonError(upstream.status === 429 ? 429 : 502, {
        code: upstream.status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_UPSTREAM_ERROR",
        message: upstream.status === 401 || upstream.status === 403
          ? "模型服务鉴权失败，请检查服务端密钥和接口地址。"
          : "模型服务暂时不可用，请稍后重试。",
        retryable,
      }, limitHeaders);
    }

    let rawModelResponse: unknown;
    try {
      rawModelResponse = JSON.parse(responseText) as unknown;
    } catch {
      throw new InvalidGeneratedAppError("模型服务返回了无效响应");
    }

    let outputTexts: string[];
    if (useChatJson) {
      const chatResponse = rawModelResponse as ChatModelResponse;
      const content = chatResponse.choices?.[0]?.message?.content;
      outputTexts = typeof content === "string" ? [content] : [];
    } else {
      const modelResponse = rawModelResponse as ModelResponse;
      if (modelResponse.status && modelResponse.status !== "completed") {
        console.error("Model response incomplete", { status: modelResponse.status, reason: modelResponse.incomplete_details?.reason, model });
        throw new InvalidGeneratedAppError("模型未能完成生成");
      }
      outputTexts = extractOutputTexts(modelResponse);
    }
    if (!outputTexts.length) throw new InvalidGeneratedAppError("模型没有返回生成内容");

    const output = parseModelOutput(outputTexts);
    const data = validateGeneratedApp(output);
    const response: GenerationResponse = {
      ok: true,
      data,
      meta: { mode: parsedRequest.data.currentApp ? "refine" : "create", model },
    };
    return NextResponse.json(response, { headers: limitHeaders });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return jsonError(504, { code: "MODEL_TIMEOUT", message: "生成超时，上一个预览已保留，可以重试。", retryable: true }, limitHeaders);
    }
    if (error instanceof InvalidGeneratedAppError) {
      console.error("Invalid model output", { reason: error.message, model });
      return jsonError(502, { code: "INVALID_MODEL_OUTPUT", message: "模型返回的应用未通过安全校验，上一个预览已保留，可以重试。", retryable: true }, limitHeaders);
    }
    console.error("Unexpected generation error", { name: error instanceof Error ? error.name : "unknown", model });
    return jsonError(502, { code: "GENERATION_FAILED", message: "生成失败，上一个预览已保留，可以重试。", retryable: true }, limitHeaders);
  } finally {
    clearTimeout(timeout);
  }
}
