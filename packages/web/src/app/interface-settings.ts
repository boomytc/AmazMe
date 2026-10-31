import type {
	Identity,
	InterfacePreferences,
	ModelCatalog,
	ProductSettings,
} from "../generated/contracts.ts";
import contracts from "../generated/schema.json" with { type: "json" };
import { type Locale, resolveLocale } from "../locale.ts";
import type { SettingDescriptorLike } from "../panels.ts";
import { applyTheme, resolveThemePreference } from "../theme.ts";
import { parseContract } from "../transport/api.ts";
import type { PythonClient } from "../transport/client.ts";
import {
	DEFAULT_TYPOGRAPHY,
	FONT_FAMILY_FIELDS,
	FONT_SIZE_FIELDS,
	FONT_SIZE_LIMITS,
	resolveTypography,
	type Typography,
} from "../typography.ts";

interface SettingsServices {
	readonly client: PythonClient;
	readonly active: (identity: Identity) => boolean;
	readonly catalog: () => ModelCatalog | undefined;
	readonly applied: () => void;
	readonly changed: () => void;
	readonly error: (error: unknown) => void;
}

export class InterfaceSettings {
	locale: Locale = resolveLocale("auto", navigator.languages);
	typography: Typography = { ...DEFAULT_TYPOGRAPHY };
	settings?: ProductSettings;
	globalModelIds: string[] | null = null;
	private settingsQueue = Promise.resolve();
	private readonly services: SettingsServices;
	constructor(services: SettingsServices) {
		this.services = services;
	}
	async resolveModelIds(
		patterns: readonly string[] | null,
		identity: Identity,
		catalog: ModelCatalog | undefined = this.services.catalog(),
	): Promise<string[] | null> {
		if (patterns === null) return null;
		const known = new Set(
			catalog?.models.map((model) => `${model.provider}/${model.model}`),
		);
		if (patterns.every((pattern) => known.has(pattern))) return [...patterns];
		const limit =
			contracts.$defs.ModelScopeRequest.properties.patterns.maxItems;
		const resolved = new Set<string>();
		for (let offset = 0; offset < patterns.length; offset += limit) {
			const scope = await this.services.client.call(
				"POST /api/v1/models/scope",
				{
					body: { patterns: patterns.slice(offset, offset + limit) },
					identity,
				},
			);
			for (const item of scope.models)
				resolved.add(`${item.model.provider}/${item.model.model}`);
		}
		return [...resolved];
	}
	applyPreferences(preferences: InterfacePreferences): void {
		this.locale = resolveLocale(
			preferences.locale ?? "auto",
			navigator.languages,
		);
		this.typography = resolveTypography(preferences);
		applyTheme(resolveThemePreference(preferences.appearance));
		this.services.applied();
	}
	updateSettings(
		update: (
			current: ProductSettings,
			identity: Identity,
		) => Promise<ProductSettings>,
	): Promise<void> {
		const identity = this.services.client.identity;
		if (!identity) return Promise.reject(new Error("请先连接后端"));
		const task = this.settingsQueue
			.catch(() => {})
			.then(async () => {
				const current = await this.services.client.call("GET /api/v1/settings");
				const settings = await update(current, identity);
				if (
					!this.services.active(identity) ||
					(settings.revision ?? 0) < (this.settings?.revision ?? 0)
				)
					return;
				const globalModelIds = await this.resolveModelIds(
					settings.preferences?.enabledModels ?? null,
					identity,
				);
				if (
					!this.services.active(identity) ||
					(settings.revision ?? 0) < (this.settings?.revision ?? 0)
				)
					return;
				this.settings = settings;
				this.globalModelIds = globalModelIds;
				this.applyPreferences(settings.preferences ?? {});
				this.services.changed();
			})
			.catch((error) => {
				if (this.services.active(identity)) {
					this.services.error(error);
				}
				throw error;
			});
		this.settingsQueue = task;
		return task;
	}
	updatePreferences(
		update: (current: InterfacePreferences) => InterfacePreferences,
	): Promise<void> {
		return this.updateSettings((current, identity) =>
			this.services.client.call("PUT /api/v1/settings/preferences", {
				body: {
					preferences: parseContract(
						"InterfacePreferences",
						update(current.preferences ?? {}),
					),
					expected_revision: current.revision ?? 0,
				},
				identity,
			}),
		);
	}
	async setPreference(id: string, value: string): Promise<void> {
		if (id === "display_name") {
			await this.updateSettings((current, identity) =>
				this.services.client.call("POST /api/v1/settings", {
					body: {
						display_name: value,
						expected_revision: current.revision ?? 0,
					},
					identity,
				}),
			);
			return;
		}
		const typed =
			id === "showWelcome" || id === "closeWindowPrompt"
				? value === "true"
				: FONT_SIZE_FIELDS.some((field) => field === id)
					? Number(value)
					: value;
		await this.updatePreferences((current) =>
			parseContract("InterfacePreferences", { ...current, [id]: typed }),
		);
	}
	descriptors(desktop: boolean): SettingDescriptorLike[] {
		const preferences = this.settings?.preferences ?? {};
		const descriptor = { group: "interface", explicit: true };
		const desktopDescriptor = { group: "desktop", explicit: true };
		return [
			{
				...descriptor,
				id: "appearance",
				field: "appearance",
				kind: "enum",
				options: ["system", "light", "dark"],
				value: preferences.appearance ?? "system",
			},
			{
				...descriptor,
				id: "locale",
				field: "locale",
				kind: "enum",
				options: ["auto", "zh", "en"],
				value: preferences.locale ?? "auto",
			},
			...FONT_FAMILY_FIELDS.map((field) => ({
				...descriptor,
				id: field,
				field,
				kind: "string" as const,
				value: preferences[field] ?? "",
			})),
			...FONT_SIZE_FIELDS.map((field) => ({
				...descriptor,
				id: field,
				field,
				kind: "number" as const,
				value: String(this.typography[field]),
				...FONT_SIZE_LIMITS[field],
				step: 1,
			})),
			{
				...descriptor,
				id: "showWelcome",
				field: "showWelcome",
				kind: "boolean",
				value: String(preferences.showWelcome ?? true),
			},
			{
				...descriptor,
				id: "display_name",
				field: "display_name",
				kind: "string",
				value: this.settings?.display_name ?? "",
			},
			...(desktop
				? [
						{
							...desktopDescriptor,
							id: "closeWindow",
							field: "closeWindow",
							kind: "enum" as const,
							options: ["background", "quit"],
							value: preferences.closeWindow ?? "background",
						},
						{
							...desktopDescriptor,
							id: "closeWindowPrompt",
							field: "closeWindowPrompt",
							kind: "boolean" as const,
							value: String(preferences.closeWindowPrompt ?? true),
						},
					]
				: []),
		];
	}
}
