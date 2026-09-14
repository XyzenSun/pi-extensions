import { execFileSync } from "node:child_process";

const ALLOWED_BRANCH = "main";

function currentBranch() {
	try {
		return execFileSync("git", ["branch", "--show-current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// Fallback for older git versions without --show-current.
		try {
			return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	}
}

const branch = currentBranch();
if (branch !== ALLOWED_BRANCH) {
	process.stderr.write(
		branch
			? `Refusing to publish: current branch is "${branch}", expected "${ALLOWED_BRANCH}".\n`
			: `Refusing to publish: not on a branch (detached HEAD), expected "${ALLOWED_BRANCH}".\n`,
	);
	process.exitCode = 1;
} else {
	process.stdout.write(`On branch "${branch}" — publish allowed.\n`);
}
