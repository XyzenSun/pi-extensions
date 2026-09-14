/**
 * 并发锁
 *
 * 锁文件：~/.pi/agent/.pi-sync/sync.lock
 * 锁信息包含 pid、hostname、开始时间、操作类型
 */
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

export interface LockInfo {
	pid: number;
	hostname: string;
	startedAt: string;
	operation: string;
}

export class SyncLock {
	private lockPath: string;
	private acquired: boolean = false;
	private lockInfo: LockInfo | null = null;

	constructor(syncDir: string) {
		this.lockPath = join(syncDir, "sync.lock");
	}

	/**
	 * 尝试获取锁
	 * @param operation 正在执行的操作（用于诊断）
	 * @param timeoutMs 最大等待时间（毫秒），默认 0 表示立即返回
	 */
	async acquire(operation: string, timeoutMs: number = 0): Promise<boolean> {
		const startTime = Date.now();

		while (true) {
			// 始终创建完整的锁路径。首次调用 `/pisync` 时，
			// agent 目录可能尚不存在。
			const lockDir = join(this.lockPath, "..");
			await mkdir(lockDir, { recursive: true });

			if (existsSync(this.lockPath)) {
				// 检查锁是否过期
				const stale = await this.isStale();
				if (stale) {
					// 当前实例并不拥有失效锁，必须直接清理后再尝试排他创建。
					await unlink(this.lockPath).catch(() => undefined);
				} else {
					// 锁仍有效，判断是否超时
					if (timeoutMs > 0 && Date.now() - startTime < timeoutMs) {
						await new Promise((resolve) => setTimeout(resolve, 200));
						continue;
					}
					return false;
				}
			}

			// 尝试创建锁文件（可能失败如果存在竞争）
			try {
				this.lockInfo = {
					pid: process.pid,
					hostname: hostname(),
					startedAt: new Date().toISOString(),
					operation,
				};

				await writeFile(
					this.lockPath,
					JSON.stringify(this.lockInfo, null, 2),
					{ flag: "wx" }, // 排他创建，如果文件已存在则失败
				);

				this.acquired = true;
				return true;
			} catch {
				// 竞争条件：另一个进程刚好创建了锁
				if (timeoutMs > 0 && Date.now() - startTime < timeoutMs) {
					await new Promise((resolve) =>
						setTimeout(resolve, 100 + Math.random() * 200),
					);
					continue;
				}
				return false;
			}
		}
	}

	/**
	 * 释放锁
	 */
	async release(): Promise<void> {
		if (!this.acquired && !existsSync(this.lockPath)) {
			return;
		}

		// 只释放自己创建的锁
		if (this.acquired && existsSync(this.lockPath)) {
			try {
				const content = await readFile(this.lockPath, "utf-8");
				const existing = JSON.parse(content) as LockInfo;

				if (existing.pid === this.lockInfo?.pid) {
					await unlink(this.lockPath);
				}
			} catch {
				// 忽略释放锁时的错误
			}
		}

		this.acquired = false;
		this.lockInfo = null;
	}

	/**
	 * 读取当前锁信息
	 */
	async readLock(): Promise<LockInfo | null> {
		if (!existsSync(this.lockPath)) return null;

		try {
			const content = await readFile(this.lockPath, "utf-8");
			return JSON.parse(content) as LockInfo;
		} catch {
			return null;
		}
	}

	/**
	 * 检查锁是否过期（进程不存在）
	 */
	private async isStale(): Promise<boolean> {
		const info = await this.readLock();
		// 文件存在但无法解析时不可能证明锁仍有效；允许下一次 acquire 恢复。
		if (!info) return existsSync(this.lockPath);

		// 检查进程是否仍在运行
		try {
			// 发送信号 0 检查进程是否存在（不实际发送信号）
			process.kill(info.pid, 0);
			return false; // 进程存在，锁有效
		} catch {
			// 进程不存在，锁已过期
			return true;
		}
	}
}
