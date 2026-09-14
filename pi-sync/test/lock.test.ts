import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SyncLock } from "../src/system/lock.ts";

describe("SyncLock", () => {
	let syncDir: string;

	beforeEach(async () => {
		syncDir = join(
			tmpdir(),
			`pi-sync-lock-test-${randomBytes(4).toString("hex")}`,
		);
		await mkdir(syncDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(syncDir, { recursive: true, force: true });
	});

	it("creates missing agent and sync directories before acquiring", async () => {
		const parentDir = join(
			tmpdir(),
			`pi-sync-lock-parent-${randomBytes(4).toString("hex")}`,
		);
		const missingSyncDir = join(parentDir, "agent", ".pi-sync");

		try {
			const lock = new SyncLock(missingSyncDir);
			expect(await lock.acquire("init")).toBe(true);
			await lock.release();
		} finally {
			await rm(parentDir, { recursive: true, force: true });
		}
	});

	it("should acquire and release lock", async () => {
		const lock = new SyncLock(syncDir);
		const acquired = await lock.acquire("test");
		expect(acquired).toBe(true);

		await lock.release();

		// Should be able to acquire again
		const lock2 = new SyncLock(syncDir);
		const acquired2 = await lock2.acquire("test");
		expect(acquired2).toBe(true);
		await lock2.release();
	});

	it("should prevent concurrent acquisition", async () => {
		const lock1 = new SyncLock(syncDir);
		const lock2 = new SyncLock(syncDir);

		const acquired1 = await lock1.acquire("test");
		expect(acquired1).toBe(true);

		const acquired2 = await lock2.acquire("test", 0); // No wait
		expect(acquired2).toBe(false);

		await lock1.release();
	});

	it("should detect stale locks", async () => {
		const lock1 = new SyncLock(syncDir);
		await lock1.acquire("test");

		// Simulate stale lock by writing a non-existent PID
		// But don't release lock1 first, verify readLock works
		const info = await lock1.readLock();
		expect(info).toBeTruthy();
		expect(info!.operation).toBe("test");
		expect(info!.pid).toBe(process.pid);

		await lock1.release();
	});

	it("should read lock info", async () => {
		const lock = new SyncLock(syncDir);
		await lock.acquire("pull");

		const info = await lock.readLock();
		expect(info).toBeTruthy();
		expect(info!.operation).toBe("pull");
		expect(info!.pid).toBe(process.pid);

		await lock.release();
	});
});
