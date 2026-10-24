"""The native plugin's bounded AX candidates and deterministic risk filters."""

import hashlib
import json
import re
from collections import Counter
from typing import Literal

from pydantic import JsonValue

from .contracts import ComputerCandidate, ComputerCaptureView, ComputerPolicy, ComputerRect, RiskCategory

FALLBACKS = {'reobserve':'Take a fresh observation; do not act','abstain':'No safe matching action; do not act'}
RISK_PHRASES: dict[RiskCategory,list[str]] = {
    'destructive':['delete','remove','erase','trash','discard','clear all','format','reset','删除','移除','清空','重置','丢弃'],
    'send':['send','submit','post','publish','share','reply','发送','提交','发布','分享','回复'],
    'purchase':['buy','purchase','pay','checkout','order','subscribe','购买','付款','支付','下单','订阅'],
    'close_unsaved':['close','quit','exit',"don't save",'discard changes','关闭','退出','不保存'],
}
ROLES: dict[str,Literal['button','toggle','checkbox','radio','popup','menu_item','link','text_input']] = {
    'button':'button','splitbutton':'button','switch':'toggle','togglebutton':'toggle','checkbox':'checkbox',
    'radiobutton':'radio','popupbutton':'popup','combobox':'popup','menubutton':'popup','menuitem':'menu_item',
    'checkmenuitem':'menu_item','radiomenuitem':'menu_item','link':'link','hyperlink':'link','textfield':'text_input',
    'textarea':'text_input','searchfield':'text_input','securetextfield':'text_input','edit':'text_input',
    'entry':'text_input','text':'text_input','passwordtext':'text_input',
}
ROOTS = {'window','frame','application'}
CHROME = {'titlebar','menubar','menubaritem'}


def blocked_risks(text: str, policy: ComputerPolicy) -> list[RiskCategory]:
    text = text.lower().replace('’',"'")
    return [kind for kind,phrases in RISK_PHRASES.items() if kind not in policy.allow_risk_categories and any(
        phrase in text if not phrase.isascii() else re.search(r'(?<![a-z0-9])'+re.escape(phrase)+r'(?![a-z0-9])',text)
        for phrase in phrases)]


def normalized_role(value: JsonValue) -> str:
    role = re.sub(r'[^a-z0-9]','',value.lower()) if isinstance(value,str) else ''
    role = re.sub(r'^ax','',role)
    return 'button' if role == 'pushbutton' else role


def rect(value: JsonValue) -> ComputerRect | None:
    if not isinstance(value,dict):
        return None
    try:
        return ComputerRect.model_validate({'x':value.get('x'),'y':value.get('y'),
            'width':value.get('width',value.get('w')),'height':value.get('height',value.get('h'))})
    except ValueError:
        return None


def intersects(a: ComputerRect, b: ComputerRect) -> bool:
    return (a.width > 0 and a.height > 0 and min(a.x+a.width,b.x+b.width) > max(a.x,b.x)
            and min(a.y+a.height,b.y+b.height) > max(a.y,b.y))


def extract_candidates(capture: ComputerCaptureView, policy: ComputerPolicy) -> list[ComputerCandidate]:
    indexed = {item['element_index']:item for item in capture.elements if isinstance(item.get('element_index'),(int,str))}
    pending: list[ComputerCandidate] = []
    for item in capture.elements:
        role = ROLES.get(normalized_role(item.get('role')))
        raw_label = item.get('label')
        label = re.sub(r'\s+',' ',raw_label).strip() if isinstance(raw_label,str) else ''
        frame = rect(item.get('frame'))
        token = item.get('element_token')
        if (not role or not label or item.get('unlabelled') is True or item.get('enabled') is False
                or item.get('visible') is False or item.get('offscreen') is True or frame is None
                or capture.window_bounds is None or not intersects(frame,capture.window_bounds)
                or not isinstance(token,str) or not token or blocked_risks(label,policy)):
            continue
        ancestors: list[dict[str, JsonValue]] = []
        index = item.get('element_index')
        seen: set[int | str] = {index} if isinstance(index,(int,str)) else set()
        parent_index = item.get('parent_index')
        parent = indexed.get(parent_index) if isinstance(parent_index,(int,str)) else None
        while parent is not None:
            key = parent.get('element_index')
            if not isinstance(key,(int,str)) or key in seen:
                break
            seen.add(key)
            ancestors.append(parent)
            key = parent.get('parent_index')
            parent = indexed.get(key) if isinstance(key,(int,str)) else None
        if parent is not None or any(normalized_role(element.get('role')) in CHROME for element in [*ancestors,item]):
            continue
        if normalized_role(item.get('subrole')) in {'closebutton','minimizebutton','zoombutton','fullscreenbutton'}:
            continue
        if (role == 'button' and ancestors and normalized_role(ancestors[0].get('role')) in ROOTS
                and re.fullmatch(r'(close|minimi[sz]e|maximi[sz]e|zoom|关闭|最小化|最大化)',label,re.I)):
            continue
        path = [[normalized_role(element.get('role')),element.get('label') or ''] for element in reversed(ancestors)]
        key = 'ax_' + hashlib.sha256(json.dumps([role,label,path],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()[:20]
        value = item.get('value')
        pending.append(ComputerCandidate(id=key,role=role,label=label,element_token=token,value=value[:1000] if isinstance(value,str) else None))
    counts = Counter(candidate.id for candidate in pending)
    return [candidate for candidate in pending if counts[candidate.id] == 1][:24]


def visual_fallback_reason(capture: ComputerCaptureView) -> str:
    if capture.degraded_reason.startswith('ax_tree_empty') or not any(normalized_role(item.get('role')) not in ROOTS for item in capture.elements):
        return 'ax_tree_empty'
    return '' if capture.candidates else 'target_not_in_ax_candidates'
