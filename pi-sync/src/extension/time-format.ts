/**
 * 时间戳的展示格式（本地时区）
 *
 * state.json 的 lastSyncedAt 由 `new Date().toISOString()` 写入，是 UTC 字符串；
 * 直接截取前 16 位等于把 UTC 当成当地时间显示，UTC+8 的机器上会差 8 小时。
 * 面向用户的时间展示统一走这里：换算到本机时区后只留到分钟——秒和时区后缀
 * 对用户没有意义。
 */
export function formatLocalTimestamp(iso: string): string {
	const date = new Date(iso);
	// 非标准时间戳（状态文件被手改等）：原样返回，避免格式化异常打断渲染
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number): string => String(value).padStart(2, "0");
	const datePart = [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
	].join("-");
	const timePart = [pad(date.getHours()), pad(date.getMinutes())].join(":");
	return `${datePart} ${timePart}`;
}
