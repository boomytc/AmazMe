import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";
import type { RefObject } from "react";
import { useState } from "react";
import type { Locale } from "../locale.ts";
import type { PanelField } from "../panels.ts";
import { translate } from "../strings.ts";

type ComboboxFieldProps = Pick<
	Extract<PanelField, { kind: "combobox" }>,
	"id" | "label" | "value" | "options" | "placeholder"
> & {
	readonly locale: Locale;
	readonly disabled: boolean;
	readonly describedBy?: string;
	readonly popupContainer: RefObject<HTMLElement | null>;
	readonly onChange: (value: string) => void;
};

type Option = ComboboxFieldProps["options"][number];
const searchText = (value: string): string =>
	value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\s._-]+/gu, "");

export function ComboboxField({
	id,
	label,
	value,
	options,
	placeholder,
	locale,
	disabled,
	describedBy,
	popupContainer,
	onChange,
}: ComboboxFieldProps) {
	const [query, setQuery] = useState<string | null>(null);
	const selected = options.find((option) => option.value === value) ?? null;
	return (
		<Combobox.Root<Option>
			items={options}
			value={selected}
			inputValue={query ?? selected?.label ?? ""}
			disabled={disabled}
			autoHighlight
			isItemEqualToValue={(left, right) => left.value === right.value}
			filter={(option, text) =>
				searchText(`${option.label} ${option.value}`).includes(searchText(text))
			}
			onInputValueChange={(text, details) => {
				if (details.reason === "input-change") {
					setQuery(text);
					onChange("");
				}
			}}
			onValueChange={(option) => {
				setQuery(null);
				onChange(option?.value ?? "");
			}}
			onOpenChange={(open) => {
				if (!open) setQuery(null);
			}}
		>
			<Combobox.InputGroup className="combobox-input">
				<Combobox.Input
					id={id}
					className="modal-input"
					placeholder={placeholder}
					aria-label={label}
					aria-describedby={describedBy}
					autoComplete="off"
					spellCheck={false}
				/>
				<Combobox.Trigger className="combobox-toggle" aria-label={label}>
					<ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
				</Combobox.Trigger>
			</Combobox.InputGroup>
			<Combobox.Portal container={popupContainer}>
				<Combobox.Positioner
					className="combobox-positioner"
					sideOffset={6}
					align="start"
					positionMethod="fixed"
				>
					<Combobox.Popup className="combobox-dropdown">
						<Combobox.Empty className="menu-empty">
							{translate(locale, "modal.noMatches")}
						</Combobox.Empty>
						<Combobox.List className="combobox-list" aria-label={label}>
							{(option: Option) => (
								<Combobox.Item
									key={option.value}
									value={option}
									className="combobox-option"
								>
									<Combobox.ItemIndicator className="combobox-indicator">
										<Check size={16} strokeWidth={1.75} aria-hidden="true" />
									</Combobox.ItemIndicator>
									<span>{option.label}</span>
									{option.value !== option.label && (
										<small>{option.value}</small>
									)}
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
}
