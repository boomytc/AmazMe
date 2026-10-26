from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, JsonValue, field_validator, model_validator

from amazme_backend.contracts.models import ImagePart
from amazme_backend.shared.model import Model

RiskCategory = Literal["destructive", "send", "purchase", "close_unsaved"]


class ComputerPolicy(Model):
    enabled: bool = False
    allow_foreground: bool = False
    max_age_ms: int = Field(default=55000, ge=1, le=55000)
    jev_enabled: bool = True
    jev_provider: str = Field(default="typesafe",min_length=1,max_length=200)
    jev_model: str = Field(default="jev-1.14.0",min_length=1,max_length=200)
    min_presence: float = Field(default=.8,ge=0,le=1)
    min_box_confidence: float = Field(default=.7,ge=0,le=1)
    min_choice_confidence: float = Field(default=.7,ge=0,le=1)
    allow_risk_categories: list[RiskCategory] = Field(default_factory=lambda:list[RiskCategory](),max_length=4)
    timeout_ms: int = Field(default=30000,ge=100,le=300000)

    @field_validator("allow_risk_categories")
    @classmethod
    def unique_risks(cls, value: list[RiskCategory]) -> list[RiskCategory]:
        if len(set(value)) != len(value):
            raise ValueError("risk categories must be unique")
        return value


class ComputerWindow(Model):
    pid: int = Field(ge=1)
    window_id: int = Field(ge=1)


class ComputerRect(Model):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(allow_inf_nan=False)
    height: float = Field(allow_inf_nan=False)


class ComputerCandidate(Model):
    id: str
    role: Literal["button","toggle","checkbox","radio","popup","menu_item","link","text_input"]
    label: str
    element_token: str
    value: str | None = None


class ComputerCaptureView(Model):
    capture_id: str
    width: int
    height: int
    raw_width: int
    raw_height: int
    orientation: int
    scale: int
    observed_ms: int
    target: ComputerWindow | None = None
    snapshot_id: str = ""
    tree: str = Field(default="", max_length=20000)
    elements: list[dict[str, JsonValue]] = Field(default_factory=lambda: list[dict[str, JsonValue]](), max_length=500)
    window_bounds: ComputerRect | None = None
    degraded_reason: str = ""
    candidates: list[ComputerCandidate] = Field(default_factory=lambda:list[ComputerCandidate](),max_length=24)


class ComputerObserve(Model):
    permitted: bool
    accessibility: bool = False
    screen: bool = False
    identity: str = ""
    error: str = ""
    capture: ComputerCaptureView | None = None
    image_base64: str = Field(default="", max_length=48 * 1024 * 1024)
    data: dict[str, JsonValue] = Field(default_factory=lambda: dict[str, JsonValue]())


class ComputerPixel(Model):
    x: int = Field(ge=0, le=100000)
    y: int = Field(ge=0, le=100000)


class ComputerElement(Model):
    element_token: str = Field(min_length=1, max_length=256)


class ComputerClick(Model):
    action: Literal["click", "double_click", "right_click"]
    point: ComputerPixel | ComputerElement


class ComputerText(ComputerElement):
    action: Literal["type_text", "set_value"]
    text: str = Field(max_length=16000)


class ComputerKey(Model):
    action: Literal["press_key"]
    key: str = Field(min_length=1, max_length=80)


class ComputerHotkey(Model):
    action: Literal["hotkey"]
    keys: list[str] = Field(min_length=2, max_length=8)

    @field_validator("keys")
    @classmethod
    def bounded_keys(cls, value: list[str]) -> list[str]:
        if any(not key or len(key) > 80 for key in value):
            raise ValueError("keys must contain 1 to 80 characters")
        return value


class ComputerScroll(ComputerPixel):
    action: Literal["scroll"]
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(default=3, ge=1, le=100)


class ComputerDrag(ComputerPixel):
    action: Literal["drag"]
    to_x: int = Field(ge=0, le=100000)
    to_y: int = Field(ge=0, le=100000)


ComputerAction = Annotated[ComputerClick | ComputerText | ComputerKey | ComputerHotkey | ComputerScroll | ComputerDrag,
                           Field(discriminator="action")]


class ComputerMutation(Model):
    capture_id: str = Field(min_length=1, max_length=128)
    target: ComputerWindow | None = None
    delivery_mode: Literal["background", "foreground"] = "background"
    action: ComputerAction
    intent: str = Field(default="",max_length=4000)


class ComputerLocate(Model):
    capture_id: str = Field(min_length=1,max_length=128)
    target: ComputerWindow | None = None
    description: str = Field(min_length=1,max_length=4000)
    mode: Literal["look_closer","tiled"] = "look_closer"


class ComputerGround(Model):
    target: ComputerWindow
    goal: str = Field(min_length=1,max_length=4000)
    verification: str = Field(min_length=1,max_length=4000)
    action: Literal["click","set_value","type_text"] = "click"
    text: str | None = Field(default=None,max_length=16000)

    @model_validator(mode="after")
    def required_text(self) -> ComputerGround:
        if self.action != "click" and self.text is None:
            raise ValueError("text actions require explicit text")
        return self


class ComputerLocateRequest(ComputerLocate):
    action_id: str = Field(min_length=1,max_length=128,pattern=r"^[\w.-]+$")


class ComputerGroundRequest(ComputerGround):
    action_id: str = Field(min_length=1,max_length=128,pattern=r"^[\w.-]+$")


class ComputerInspect(Model):
    action: Literal["desktop", "window", "apps", "windows", "permissions"] = "desktop"
    target: ComputerWindow | None = None
    pid: int | None = Field(default=None, ge=1)


class ComputerActionRequest(ComputerMutation):
    action_id: str = Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")


class ComputerActionView(Model):
    action_id: str
    session_id: str
    phase: Literal["unknown", "done", "failed"]
    error: str = ""
    driver_x: int | None = None
    driver_y: int | None = None
    result: dict[str, JsonValue] = Field(default_factory=lambda:dict[str, JsonValue]())
    images: list[ImagePart] = Field(default_factory=lambda:list[ImagePart]())


class ComputerCleanup(Model):
    cleared: bool
    proof: str = ""
