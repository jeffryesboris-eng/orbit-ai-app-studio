import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.argv[2] || ".env.local");
const required = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

function parseEnv(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

if (!fs.existsSync(envPath)) {
  console.error(`环境变量文件不存在：${envPath}`);
  process.exit(1);
}

const values = parseEnv(fs.readFileSync(envPath, "utf8"));
const missing = required.filter((key) => !values.get(key)?.trim());
const errors = [];

if (missing.length) errors.push(`缺少必填变量：${missing.join(", ")}`);

const supabaseUrl = values.get("NEXT_PUBLIC_SUPABASE_URL")?.trim();
if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
  errors.push("NEXT_PUBLIC_SUPABASE_URL 格式不正确");
}

const publishableKey = values.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")?.trim();
if (publishableKey && !/^(sb_publishable_|eyJ)/.test(publishableKey)) {
  errors.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 格式不正确");
}

const baseUrl = values.get("OPENAI_BASE_URL")?.trim();
if (baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") errors.push("OPENAI_BASE_URL 必须使用 HTTPS");
  } catch {
    errors.push("OPENAI_BASE_URL 不是有效 URL");
  }
}

if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}

console.log(`✓ ${required.length} 个必填环境变量已配置`);
console.log("✓ Supabase 公共配置格式正确");
console.log("✓ 未输出任何密钥内容");
