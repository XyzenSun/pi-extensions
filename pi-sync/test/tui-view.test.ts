import { describe, expect, it } from "vitest";
import {
	beginAction,
	createTuiState,
	finishAction,
	markBusy,
	moveMenuSelection,
	raiseConflict,
	setConfirmChoice,
	setConflictExit,
	setProgress,
	type TuiStatusSummary,
} from "../src/extension/tui-state.ts";
import {
	labelForAction,
	renderPageBody,
	renderStatusSummary,
	renderTui,
	type ThemeLike,
} from "../src/extension/tui-view.ts";

/** 把 role 标记进文本，便于断言"哪一段用了什么颜色"。 */
const theme: ThemeLike = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bold: (text) => `*${text}*`,
};

function statusSummary(
	overrides: Partial<TuiStatusSummary> = {},
): TuiStatusSummary {
	return {
		branch: "main",
		ahead: 0,
		behind: 0,
		pendingChanges: 0,
		conflicts: 0,
		autoSyncEnabled: false,
		lastSyncedAt: null,
		...overrides,
	};
}

function plain(lines: string[]): string {
	return lines.join("\n").replace(/<\/?[a-z]+>/g, "");
}

describe("tui view", () => {
	it("always shows branch, sync gap, last sync and autoSync in the summary", () => {
		// lastSyncedAt 存的是 UTC，展示要换算到本机时区；固定时区才能断言具体值
		const previousTimeZone = process.env.TZ;
		process.env.TZ = "Asia/Shanghai";
		try {
			const lines = renderStatusSummary(
				createTuiState(
					statusSummary({
						ahead: 2,
						behind: 3,
						lastSyncedAt: "2026-09-11T08:30:12.000Z",
						autoSyncEnabled: true,
					}),
				),
				theme,
			);
			const text = plain(lines);
			expect(text).toContain("分支 main");
			expect(text).toContain("待推送 2 · 待拉取 3");
			// 08:30Z 在 UTC+8 是当天 16:30
			expect(text).toContain("上次同步 2026-09-11 16:30");
			expect(text).toContain("自动同步：开");
		} finally {
			if (previousTimeZone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimeZone;
		}
	});

	it("reports an up-to-date repository instead of zero counters", () => {
		const text = plain(
			renderStatusSummary(createTuiState(statusSummary()), theme),
		);
		expect(text).toContain("已是最新");
		expect(text).toContain("没有待同步的变更");
		expect(text).toContain("从未同步");
	});

	it("highlights conflicts in the summary with the error role", () => {
		const lines = renderStatusSummary(
			createTuiState(statusSummary({ pendingChanges: 4, conflicts: 2 })),
			theme,
		);
		expect(lines.join("\n")).toContain("<error>2 个冲突</error>");
	});

	it("marks the selected menu entry and keeps destructive entries warned", () => {
		const state = createTuiState(statusSummary());
		const lines = renderPageBody(state, theme);
		expect(lines[0]).toContain("❯ ");
		expect(lines[0]).toContain("智能化拉取");
		// 破坏性档位即使未选中也是警示色。
		expect(lines.join("\n")).toContain("<warning>以远端覆盖本机</warning>");
		expect(lines.join("\n")).toContain("<warning>以本机覆盖远端</warning>");

		const moved = moveMenuSelection(state, 1);
		expect(renderPageBody(moved, theme)[1]).toContain("❯ ");
	});

	it("lists the concrete losing paths on the confirm page (PRD 4.2 #1)", () => {
		const state = beginAction(
			createTuiState(statusSummary()),
			"pull-overwrite-local",
			{ paths: ["prompts/a.md", "settings.json"] },
		);
		const text = plain(renderPageBody(state, theme));
		expect(text).toContain("以下 2 项内容将被丢弃");
		expect(text).toContain("prompts/a.md");
		expect(text).toContain("settings.json");
		expect(text).toContain("落地前会自动备份");
	});

	it("discloses truncation instead of silently dropping paths", () => {
		const paths = Array.from({ length: 30 }, (_v, i) => `prompts/${i}.md`);
		const state = beginAction(
			createTuiState(statusSummary()),
			"push-overwrite-remote",
			{ paths, limit: 3 },
		);
		const text = plain(renderPageBody(state, theme));
		expect(text).toContain("以下 30 项内容将被丢弃");
		expect(text).toContain("另有 27 项未列出");
	});

	it("defaults the confirm page cursor to cancel", () => {
		const state = beginAction(
			createTuiState(statusSummary()),
			"pull-overwrite-local",
			{ paths: ["x"] },
		);
		const rendered = renderPageBody(state, theme).join("\n");
		expect(rendered).toContain("❯ 取消");
		expect(rendered).not.toContain("❯ 确认执行");

		const confirming = setConfirmChoice(state, "confirm");
		const afterToggle = renderPageBody(confirming, theme).join("\n");
		expect(afterToggle).toContain("❯ 确认执行");
		// 选中"确认执行"时用 error 角色，让破坏性更显眼。
		expect(afterToggle).toContain("<error>❯ 确认执行</error>");
	});

	it("shows only the two D9 exits on the conflict page", () => {
		const state = raiseConflict(createTuiState(statusSummary()), {
			conflictPaths: ["prompts/welcome.md"],
			deviceBranch: "pisync-device/host-abc",
		});
		const text = plain(renderPageBody(state, theme));
		expect(text).toContain("检测到 Git 冲突");
		expect(text).toContain("prompts/welcome.md");
		expect(text).toContain("origin/pisync-device/host-abc");
		expect(text).toContain("请 agent 解决冲突");
		expect(text).toContain("停止 —— 我自己处理");
		// D9：不得出现任何逐文件选边的入口。
		expect(text).not.toContain("逐个文件");
		expect(text).not.toContain("使用本机内容");
		expect(text).not.toContain("使用远端内容");
		// 默认停在"我自己处理"。
		expect(renderPageBody(state, theme).join("\n")).toContain(
			"❯ 停止 —— 我自己处理",
		);
		expect(
			renderPageBody(setConflictExit(state, "ask-agent"), theme).join("\n"),
		).toContain("❯ 请 agent 解决冲突");
	});

	it("notes when git reported no conflict paths", () => {
		const state = raiseConflict(createTuiState(statusSummary()), {
			conflictPaths: [],
			deviceBranch: "pisync-device/host-abc",
		});
		expect(plain(renderPageBody(state, theme))).toContain(
			"git 未报告具体路径",
		);
	});

	it("reports what actually happened on the result page (D4)", () => {
		const ok = finishAction(
			markBusy(createTuiState(statusSummary()), "pull-smart"),
			{
				action: "pull-smart",
				ok: true,
				message: "已应用 3 个文件。\n已安装 1 个包。",
				reload: true,
			},
		);
		const text = plain(renderPageBody(ok, theme));
		expect(text).toContain("完成：智能化拉取");
		expect(text).toContain("已应用 3 个文件。");
		expect(text).toContain("已安装 1 个包。");
		expect(text).toContain("配置已变更，退出后可以 reload 使其生效。");

		const failed = finishAction(
			markBusy(createTuiState(statusSummary()), "push-smart"),
			{ action: "push-smart", ok: false, message: "推送被拒绝。", reload: false },
		);
		const failedText = plain(renderPageBody(failed, theme));
		expect(failedText).toContain("未完成：智能化推送");
		expect(failedText).not.toContain("reload");
	});

	it("shows progress while an action is running and blocks key hints", () => {
		const busy = setProgress(
			markBusy(createTuiState(statusSummary()), "pull-smart"),
			"正在执行：git fetch origin……",
		);
		const body = plain(renderPageBody(busy, theme));
		expect(body).toContain("正在执行：智能化拉取");
		expect(body).toContain("git fetch origin");
		expect(plain(renderTui(busy, theme))).toContain("执行中");
	});

	it("keeps the summary visible on every page and appends key hints", () => {
		const state = createTuiState(statusSummary({ pendingChanges: 1 }));
		for (const candidate of [
			state,
			beginAction(state, "pull-overwrite-local", { paths: ["a"] }),
			raiseConflict(state, { conflictPaths: [], deviceBranch: "d" }),
			finishAction(state, {
				action: "pull-smart",
				ok: true,
				message: "done",
				reload: false,
			}),
		]) {
			const text = plain(renderTui(candidate, theme));
			expect(text).toContain("pi-sync");
			expect(text).toContain("分支 main");
		}
		expect(plain(renderTui(state, theme))).toContain("Enter 执行");
	});

	it("renders nothing once closed", () => {
		const state = createTuiState(statusSummary());
		expect(
			renderTui({ ...state, page: { kind: "closed", pending: null } }, theme),
		).toEqual([]);
	});

	it("exposes action labels for reuse in notifications", () => {
		expect(labelForAction("push-overwrite-remote")).toBe("以本机覆盖远端");
		expect(labelForAction("view-diff")).toBe("查看差异");
	});
});