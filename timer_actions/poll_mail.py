# -*- coding: utf-8 -*-
"""Agent Mail 定时轮询动作（timer_actions 扩展点）。

config.yaml 通过 ``timer_actions`` 声明本目录；TimerManager 到点后调用
``timer_action(name, params)``，内部转调 plugin/api.py 的 ``poll_new_messages``
完成「列新邮件 → 匹配规则 → 派发 Agent / 进待确认队列」的自动处理。

plugin/ 目录不在 sys.path，需手动加入后动态加载 api 模块。
"""

from __future__ import annotations

import os
import sys
from typing import Any
from typing import Dict

TIMER_ACTION_NAME = "agent_mail_poll"
TIMER_ACTION_DESCRIPTION = "轮询 Agent Mail 邮箱新邮件并按规则自动处理"


def _load_api():
    """动态加载 plugin/api.py（plugin 目录不在 sys.path）。"""
    plugin_dir = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin")
    )
    if plugin_dir not in sys.path:
        sys.path.insert(0, plugin_dir)
    import api  # noqa: E402

    return api


def timer_action(name: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """定时动作入口：轮询新邮件并触发自动处理。"""
    api = _load_api()
    return api.poll_new_messages()
