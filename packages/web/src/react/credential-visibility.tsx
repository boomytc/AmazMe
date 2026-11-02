import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { Locale } from "../locale.ts";
import { translate } from "../strings.ts";

interface CredentialToggleProps {
	readonly shown: boolean;
	readonly locale: Locale;
	readonly disabled?: boolean;
	readonly controls?: string;
	readonly onToggle: () => void;
}

export function CredentialToggle({
	shown,
	locale,
	disabled,
	controls,
	onToggle,
}: CredentialToggleProps) {
	const label = translate(
		locale,
		shown ? "secret.hideAria" : "secret.showAria",
	);
	const VisibilityIcon = shown ? EyeOff : Eye;
	return (
		<button
			type="button"
			className="credential-toggle"
			aria-label={label}
			title={label}
			aria-pressed={shown}
			aria-controls={controls}
			disabled={disabled}
			onClick={onToggle}
		>
			<VisibilityIcon size={18} strokeWidth={1.75} aria-hidden="true" />
		</button>
	);
}

interface CredentialSecretProps {
	readonly text: string;
	readonly masked: string;
	readonly locale: Locale;
}

export function CredentialSecret({
	text,
	masked,
	locale,
}: CredentialSecretProps) {
	// A reveal belongs to the credential, not to a reused span at the same text offset.
	const [revealed, setRevealed] = useState<string | null>(null);
	const shown = revealed === text;
	return (
		<span className="credential-secret">
			<span className="credential-value">{shown ? text : masked}</span>
			<CredentialToggle
				shown={shown}
				locale={locale}
				onToggle={() => setRevealed(shown ? null : text)}
			/>
		</span>
	);
}
