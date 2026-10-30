import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		passWithNoTests: false,
		pool: "forks",
		maxWorkers: 1,
		fileParallelism: false,
		projects: [
			{
				extends: true,
				test: {
					name: "docs",
					include: ["evals/**/*.docs.eval.ts"],
					sequence: { concurrent: false },
					testTimeout: 300_000,
					hookTimeout: 300_000,
				},
			},
			{
				extends: true,
				test: {
					name: "host",
					include: ["evals/**/*.eval.ts"],
					exclude: ["evals/**/*.docs.eval.ts"],
					sequence: { concurrent: false },
					testTimeout: 300_000,
					hookTimeout: 300_000,
				},
			},
		],
	},
});
