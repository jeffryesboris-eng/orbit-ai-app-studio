import { generatedAppSchema, type GeneratedApp } from "@/lib/generation-contract";

const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-src 'none'";

export class InvalidGeneratedAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGeneratedAppError";
  }
}

function assertSafeHtml(html: string) {
  const required = [
    [/<!doctype\s+html/i, "缺少 HTML doctype"],
    [/<html(?:\s|>)/i, "缺少 html 元素"],
    [/<head(?:\s|>)/i, "缺少 head 元素"],
    [/<body(?:\s|>)/i, "缺少 body 元素"],
    [/<\/html>/i, "HTML 文档未闭合"],
  ] as const;

  for (const [pattern, message] of required) {
    if (!pattern.test(html)) throw new InvalidGeneratedAppError(message);
  }

  const forbidden = [
    [/<script\b[^>]*\bsrc\s*=/i, "不能加载外部脚本"],
    [/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i, "不能加载外部样式"],
    [/<(?:iframe|frame|object|embed|base)\b/i, "不能嵌入外部页面或对象"],
    [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, "不能自动跳转页面"],
    [/(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/)/i, "不能引用外部资源"],
    [/(?:@import|url\s*\(\s*["']?\s*(?:https?:|\/\/))/i, "CSS 不能引用外部资源"],
    [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i, "生成应用不能发起网络请求"],
    [/<form\b[^>]*\baction\s*=/i, "表单不能提交到外部地址"],
  ] as const;

  for (const [pattern, message] of forbidden) {
    if (pattern.test(html)) throw new InvalidGeneratedAppError(message);
  }
}

function enforcePreviewCsp(html: string) {
  const withoutExistingCsp = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>\s*/gi,
    "",
  );
  return withoutExistingCsp.replace(/<head([^>]*)>/i, `<head$1><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`);
}

export function validateGeneratedApp(input: unknown): GeneratedApp {
  const parsed = generatedAppSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "root";
    throw new InvalidGeneratedAppError(`模型返回的数据结构无效：${field} ${issue?.message || "unknown"}`);
  }

  assertSafeHtml(parsed.data.html);
  return { ...parsed.data, html: enforcePreviewCsp(parsed.data.html) };
}
