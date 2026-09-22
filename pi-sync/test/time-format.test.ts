import { describe, expect, it } from "vitest";
import { formatLocalTimestamp } from "../src/extension/time-format.ts";

describe("time format", () => {
	it("renders UTC timestamps as the local wall clock at minute precision", () => {
		// 固定时区才能断言具体值，否则期望值会随 CI 所在时区漂移
		const previousTimeZone = process.env.TZ;
		process.env.TZ = "Asia/Shanghai";
		try {
			expect(formatLocalTimestamp("2026-09-11T08:30:12.000Z")).toBe(
				"2026-09-11 16:30",
			);
			// 换算后跨过本机零点：日期要跟着变
			expect(formatLocalTimestamp("2026-09-11T20:05:00.000Z")).toBe(
				"2026-09-12 04:05",
			);
		} finally {
			if (previousTimeZone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimeZone;
		}
	});

	it("returns values that are not a timestamp unchanged", () => {
		expect(formatLocalTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
	});
});
