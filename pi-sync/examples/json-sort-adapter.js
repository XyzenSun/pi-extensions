/**
 * 示例自定义 adapter：JSON 键序规范化（供 `special` 使用）
 *
 * 放在 config-repo 根（pi-sync.json 旁），然后在 pi-sync.json 里声明：
 *
 * ```json
 * {
 *   "special": {
 *     "some-config.json": "./examples-json-adapter.js"
 *   }
 * }
 * ```
 *
 * 行为：
 * - toRepository（push）：把 JSON 顶层键按字典序排序后写入仓库，让历史 diff 稳定；
 * - toLocal（pull）：仓库内容按键序重排后落回本机（本机额外键保留、追加在后）；
 * - normalizeForComparison（hash）：键序无关的规范化 JSON，纯键序差异不产生冲突。
 *
 * 三个函数都可选——缺省方向退化为 direct（字节原样）。同步时会随仓库路径解析，
 * 由本仓库 runtime（src/sync/adapter-runtime.ts）加载并调用。
 */
"use strict";

function parseJson(content) {
  try {
    const parsed = JSON.parse(content.toString("utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function serialize(obj) {
  return Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, "utf-8");
}

function sortKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value]),
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

module.exports = {
  /** push：顶层键排序后入库 */
  toRepository(local) {
    const obj = parseJson(local);
    return obj ? serialize(sortKeys(obj)) : local;
  },

  /** pull：仓库为准，但保留本机有而仓库没有的顶层键（追加在末尾） */
  toLocal(repo, local) {
    const remoteObj = parseJson(repo);
    if (!remoteObj) return repo;
    const localObj = parseJson(local) ?? {};
    const merged = { ...remoteObj };
    for (const [key, value] of Object.entries(localObj)) {
      if (!(key in remoteObj)) merged[key] = value;
    }
    return serialize(merged);
  },

  /** hash：键序无关规范化 */
  normalizeForComparison(content) {
    const obj = parseJson(content);
    return obj ? Buffer.from(JSON.stringify(canonicalize(obj))) : content;
  },
};
