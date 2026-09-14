import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const versionKind = process.argv[2];
const VERSION_KINDS = new Set(["patch", "minor", "major"]);

if (!VERSION_KINDS.has(versionKind)) {
	throw new Error(
		`Expected a version kind (${[...VERSION_KINDS].join(", ")}), received ${versionKind ?? "none"}.`,
	);
}

const packagePath = resolve("package.json");
let packageJson;
try {
	packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
} catch (error) {
	throw new Error(
		`Could not read ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
	);
}
const packageName = packageJson.name;
const currentVersion = packageJson.version;

if (typeof packageName !== "string" || typeof currentVersion !== "string") {
	throw new Error(
		`${packagePath} must contain string name and version fields.`,
	);
}

function errorOutput(error) {
	if (!(error instanceof Error)) return String(error);

	return [error.message, error.stdout, error.stderr]
		.filter((value) => value !== undefined)
		.map((value) => String(value))
		.join("\n");
}

function isMissingVersionError(error) {
	return /\bE404\b|No match found for version|404.*(?:not found|no match)/i.test(
		errorOutput(error),
	);
}

function versionIsPublished() {
	try {
		execFileSync(
			"npm",
			["view", `${packageName}@${currentVersion}`, "version", "--json"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		return true;
	} catch (error) {
		if (isMissingVersionError(error)) return false;
		throw new Error(
			`Could not determine whether ${packageName}@${currentVersion} is published: ${errorOutput(error)}`,
		);
	}
}

if (versionIsPublished()) {
	process.stdout.write(
		`${packageName}@${currentVersion} is already published; incrementing ${versionKind}.\n`,
	);
	execFileSync("npm", ["version", versionKind], { stdio: "inherit" });
} else {
	process.stdout.write(
		`${packageName}@${currentVersion} is not published; publishing it without incrementing.\n`,
	);
}

execFileSync("npm", ["publish", "--access", "public"], { stdio: "inherit" });
