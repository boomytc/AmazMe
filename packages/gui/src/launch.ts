/** Working directory for the packaged backend: an explicit project, otherwise the launching process directory. */
export function hostWorkingDirectory(env: NodeJS.ProcessEnv, cwd: string): string {
	const override = env.AMAZME_GUI_CWD;
	if (override !== undefined && override.length > 0) return override;
	return env.INIT_CWD ?? cwd;
}
