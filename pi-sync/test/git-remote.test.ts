import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canFastForward,
	gitDiffFiles,
	gitFetch,
	gitFastForward,
	gitStatus,
	isDiverged,
} from "../src/system/git.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe.sequential("Git remote integration", () => {
	it("fetches and fast-forwards a local clone from an offline bare remote", async () => {
		await withTestEnvironment(async ({ rootDir }) => {
			const fixture = await createGitFixture(rootDir);
			await fixture.writeAndCommit(
				fixture.deviceAPath,
				"sync/prompts/review.md",
				"remote change\n",
			);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			await gitFetch(fixture.deviceBPath);
			const before = await gitStatus(fixture.deviceBPath);
			expect(before).toMatchObject({
				remoteExists: true,
				ahead: 0,
				behind: 1,
				hasUncommittedChanges: false,
			});
			expect(
				await canFastForward(fixture.deviceBPath, "main", "origin/main"),
			).toBe(true);
			expect(await isDiverged(fixture.deviceBPath, "main", "origin/main")).toBe(
				false,
			);

			await expect(
				gitFastForward(fixture.deviceBPath, "main"),
			).resolves.toEqual({ pulled: true });
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/review.md"),
					"utf-8",
				),
			).toBe("remote change\n");
			await expect(
				gitFastForward(fixture.deviceBPath, "main"),
			).resolves.toEqual({ pulled: false });
		});
	});

	it("detects branch divergence and reports added, modified, and deleted files", async () => {
		await withTestEnvironment(async ({ rootDir }) => {
			const fixture = await createGitFixture(rootDir);
			const base = (await runGit(fixture.deviceAPath, ["rev-parse", "HEAD"]))
				.stdout;
			await fixture.writeAndCommit(
				fixture.deviceAPath,
				"sync/remote.md",
				"remote\n",
			);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await fixture.writeAndCommit(
				fixture.deviceBPath,
				"sync/local.md",
				"local\n",
			);

			await gitFetch(fixture.deviceBPath);
			expect(await isDiverged(fixture.deviceBPath, "main", "origin/main")).toBe(
				true,
			);
			expect(
				await canFastForward(fixture.deviceBPath, "main", "origin/main"),
			).toBe(false);
			expect(
				await canFastForward(fixture.deviceBPath, "origin/main", "main"),
			).toBe(false);

			const diffs = await gitDiffFiles(fixture.deviceAPath, base, "HEAD");
			expect(diffs).toEqual([
				{ path: "sync/remote.md", status: "added", oldPath: undefined },
			]);
		});
	});
});
