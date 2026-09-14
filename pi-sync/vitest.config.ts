import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			reportsDirectory: "./coverage",
			include: ["index.ts", "src/**/*.ts"],
			exclude: ["test/**", "test/e2e/**", "**/*.d.ts"],
			thresholds: {
				statements: 45,
				branches: 78,
				functions: 58,
				lines: 45,
			},
		},
	},
});
