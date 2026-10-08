import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// Inherited provider credentials must not turn offline tests into paid remote calls.
// Real-provider tests require an explicit opt-in; fixture tests stub their own credentials.
const providerEnvironment =
	process.env.AMAZME_TEST_LIVE === "1"
		? {}
		: Object.fromEntries(
				Object.keys(process.env)
					.filter((name) =>
						/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|GITHUB_TOKEN|HF_TOKEN|AWS_|GOOGLE_|GCLOUD_|ANTHROPIC_FEDERATION|ANTHROPIC_IDENTITY|ANTHROPIC_ORGANIZATION)/.test(
							name,
						),
					)
					.map((name) => [name, ""]),
			);

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { ...providerEnvironment, AMAZME_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@amazme\/ai$/, replacement: workspaceSourcePaths.aiIndex },
				{
					find: /^@amazme\/durable$/,
					replacement: workspaceSourcePaths.durableIndex,
				},
				{
					find: /^@amazme\/durable\/env\/node$/,
					replacement: workspaceSourcePaths.durableEnvNode,
				},
				{
					find: /^@amazme\/durable\/tools$/,
					replacement: workspaceSourcePaths.durableTools,
				},
				{
					find: /^@amazme\/durable\/storage\/sqlite\/node$/,
					replacement: workspaceSourcePaths.durableSqliteNode,
				},
				{ find: /^@amazme\/web$/, replacement: workspaceSourcePaths.webIndex },
				{
					find: /^@amazme\/web\/assets$/,
					replacement: workspaceSourcePaths.webAssets,
				},
				{
					find: /^@amazme\/agent$/,
					replacement: workspaceSourcePaths.agentIndex,
				},
			],
		},
	}),
);
