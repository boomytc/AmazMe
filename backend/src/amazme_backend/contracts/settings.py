from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import Field, field_validator

from amazme_backend.shared.model import Model


class InterfacePreferences(Model):
    """Presentation fields keep the original client's public names."""

    enabledModels: list[Annotated[str, Field(min_length=1, max_length=193)]] | None = Field(default=None, max_length=4096)
    appearance: Literal["system", "light", "dark"] = "system"
    locale: Literal["auto", "zh", "en"] = "auto"
    showWelcome: bool = True
    closeWindow: Literal["background", "quit"] = "background"
    closeWindowPrompt: bool = True
    textFont: str = Field(default="", max_length=256)
    codeFont: str = Field(default="", max_length=256)
    terminalFont: str = Field(default="", max_length=256)
    textSize: int = Field(default=15, ge=10, le=22)
    codeSize: int = Field(default=13, ge=10, le=16)
    terminalSize: int = Field(default=12, ge=10, le=20)

    @field_validator("textFont", "codeFont", "terminalFont")
    @classmethod
    def font_names(cls, value: str) -> str:
        if not value.strip():
            return ""
        parts = value.split(",")
        if len(parts) > 8:
            raise ValueError("Use at most eight font names")
        names: list[str] = []
        for part in parts:
            name = part.strip()
            if len(name) >= 2 and name[0] == name[-1] and name[0] in {"'", '"'}:
                name = name[1:-1].strip()
            if not name or any(not (character.isalnum() or character in " ._-") for character in name):
                raise ValueError("Use font names separated by commas")
            name = re.sub(" +", " ", name)
            if name not in names:
                names.append(name)
        return ", ".join(names)


class PreferencesUpdate(Model):
    preferences: InterfacePreferences
    expected_revision: int = Field(ge=0)


class ProductSettings(Model):
    display_name: str = ""
    revision: int = 0
    preferences: InterfacePreferences = Field(default_factory=InterfacePreferences)


class SettingsUpdate(Model):
    display_name: str = Field(min_length=1, max_length=80)
    expected_revision: int = Field(ge=0)
