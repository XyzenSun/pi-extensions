import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const coveragePath = resolve(
	process.env.COVERAGE_SUMMARY_PATH ?? "coverage/coverage-summary.json",
);
let summary;
try {
	summary = JSON.parse(await readFile(coveragePath, "utf8"));
} catch (error) {
	console.error(
		`Could not read coverage summary: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}

const minimums = {
	total: { statements: 75, branches: 78, functions: 90, lines: 75 },
	"extension-orchestration": {
		statements: 80,
		branches: 80,
		functions: 88,
		lines: 80,
	},
	"src/orchestration/commands.ts": {
		statements: 60,
		branches: 62,
		functions: 89,
		lines: 60,
	},
};

function coverageForFile(label) {
	const suffix = `/${label}`;
	const matches = Object.entries(summary).filter(([file]) =>
		file.endsWith(suffix),
	);
	if (matches.length !== 1) {
		throw new Error(
			`Expected one coverage entry for ${label}, found ${matches.length}.`,
		);
	}
	return matches[0][1];
}

function combineCoverage(...entries) {
	return Object.fromEntries(
		["statements", "branches", "functions", "lines"].map((metric) => {
			const covered = entries.reduce(
				(total, entry) => total + entry[metric].covered,
				0,
			);
			const total = entries.reduce(
				(total, entry) => total + entry[metric].total,
				0,
			);
			return [
				metric,
				{ covered, total, pct: total === 0 ? 100 : (covered / total) * 100 },
			];
		}),
	);
}

function coverageFor(label) {
	if (label === "total") return summary.total;
	if (label === "extension-orchestration") {
		return combineCoverage(
			coverageForFile("index.ts"),
			coverageForFile("src/extension/operation-runner.ts"),
		);
	}
	return coverageForFile(label);
}

const failures = [];
for (const [label, thresholds] of Object.entries(minimums)) {
	const metrics = coverageFor(label);
	for (const [metric, minimum] of Object.entries(thresholds)) {
		const actual = metrics[metric]?.pct;
		if (typeof actual !== "number" || actual < minimum) {
			failures.push(
				`${label} ${metric}: expected >= ${minimum}%, received ${actual ?? "missing"}%.`,
			);
		}
	}
}

if (failures.length > 0) {
	process.stderr.write("Coverage thresholds failed:\n");
	for (const failure of failures) process.stderr.write(`- ${failure}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write("Coverage thresholds passed.\n");
}
