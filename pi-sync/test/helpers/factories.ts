import type { PiSyncConfig } from "../../src/sync/config.ts";
import type { SyncState } from "../../src/system/state.ts";

export interface PiSyncConfigOverrides
	extends Omit<Partial<PiSyncConfig>, never> {}

export function createPiSyncConfig(
	overrides: PiSyncConfigOverrides = {},
): PiSyncConfig {
	const autoSync = overrides.autoSync ?? { enabled: false, intervalMinutes: 30 };
	const { special: specialOverride, autoSync: _autoSync, ...rest } = overrides;
	return {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: [
			"settings.json",
			"extensions/**",
			"skills/**",
			"prompts/**",
			"themes/**",
		],
		exclude: [],
		delete: "tracked",
		pullTimeoutMs: 30000,
		...rest,
		special: specialOverride ?? {},
		autoSync,
	};
}

export function createSyncState(overrides: Partial<SyncState> = {}): SyncState {
	return {
		schemaVersion: 3,
		repoPath: "/test/config-repo",
		branch: "main",
		lastSyncedCommit: null,
		lastSyncedAt: null,
		files: {},
		pendingOperation: null,
		lastBackup: null,
		...overrides,
	};
}
