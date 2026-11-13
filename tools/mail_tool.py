# -*- coding: utf-8 -*-
"""Agent Mail 邮件工具（tools 扩展点，供 Agent 调用）。

封装 agently-cli 的邮件读/搜/发/回/转/删操作，复用 plugin/api.py 的业务逻辑。
plugin/ 目录不在 sys.path，通过 importlib 按路径动态加载（模块名固定便于缓存）。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
from typing import Any
from typing import Dict


def _load_api():
    """按路径动态加载 plugin/api.py（模块名固定 agent_mail_api 便于缓存）。"""
    api_path = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", "api.py")
    )
    module_name = "agent_mail_api"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, api_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class mail_tool:
    """Agent Mail 邮件工具：读/搜/发/回/转/删邮件。

    用途:
    - 列出邮箱消息、读取单封邮件、搜索邮件
    - 发送新邮件、回复、转发、移入回收站、删除
    - 写操作（send/reply/forward/trash/delete）需要 confirmation-token；
      用户明确授权时可传 confirmed=True 免除。

    参数:
    - action (str): 操作类型，list/read/search/send/reply/forward/trash/delete
    - message_id (str): 邮件 ID（read/reply/forward/trash/delete 需要）
    - to (str): 收件人（send/forward 需要）
    - subject (str): 主题（send 可选）
    - body (str): 正文（send/reply/forward 可选）
    - query (str): 搜索关键词（search 需要）
    - page (int): 分页页码，默认 1
    - page_size (int): 分页大小，默认 20
    - confirmation_token (str): 写操作确认令牌（可选）
    - confirmed (bool): 用户已授权时传 true 免除确认，默认 false

    返回:
    - success (bool)
    - stdout (str): JSON 文本
    - stderr (str)
    """

    name = "mail_tool"
    description = "Agent Mail 邮件工具：读/搜/发/回/转/删邮件（封装 agently-cli）。"

    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "read", "search", "send", "reply", "forward", "trash", "delete"],
                "description": "操作类型",
            },
            "message_id": {"type": "string", "description": "邮件 ID"},
            "to": {"type": "string", "description": "收件人"},
            "subject": {"type": "string", "description": "主题"},
            "body": {"type": "string", "description": "正文"},
            "query": {"type": "string", "description": "搜索关键词"},
            "page": {"type": "integer", "description": "分页页码，默认 1"},
            "page_size": {"type": "integer", "description": "分页大小，默认 20"},
            "confirmation_token": {"type": "string", "description": "写操作确认令牌"},
            "confirmed": {"type": "boolean", "description": "用户已授权时传 true 免除确认"},
        },
        "required": ["action"],
    }

    @staticmethod
    def check() -> bool:
        """工具可用性：依赖 agently-cli，未安装时返回 False（工具不可用）。"""
        return shutil.which("agently-cli") is not None

    def execute(self, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            api = _load_api()
            action = args.get("action")
            if action not in ("list", "read", "search", "send", "reply", "forward", "trash", "delete"):
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": "参数错误：action 必须是 list/read/search/send/reply/forward/trash/delete",
                }

            result = self._dispatch(api, action, args)
            if result.get("success"):
                return {
                    "success": True,
                    "stdout": json.dumps(result.get("data", {}), ensure_ascii=False, indent=2),
                    "stderr": "",
                }
            error = result.get("error", {})
            return {
                "success": False,
                "stdout": "",
                "stderr": f"{error.get('code', 'ERROR')}: {error.get('message', '')}",
            }
        except Exception as e:
            return {
                "success": False,
                "stdout": "",
                "stderr": f"mail_tool 执行异常: {e}",
            }

    @staticmethod
    def _dispatch(api, action: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """按 action 分发到 api 对应函数。"""
        if action == "list":
            return api.list_messages(
                page=args.get("page", 1), page_size=args.get("page_size", 20)
            )
        if action == "read":
            return api.read_message(args.get("message_id", ""))
        if action == "search":
            return api.search_messages(
                args.get("query", ""),
                page=args.get("page", 1),
                page_size=args.get("page_size", 20),
            )
        if action == "send":
            return api.send_message(
                to=args.get("to", ""),
                subject=args.get("subject", ""),
                body=args.get("body", ""),
                confirmation_token=args.get("confirmation_token", ""),
                confirmed=bool(args.get("confirmed", False)),
            )
        if action == "reply":
            return api.reply_message(
                message_id=args.get("message_id", ""),
                body=args.get("body", ""),
                confirmation_token=args.get("confirmation_token", ""),
                confirmed=bool(args.get("confirmed", False)),
            )
        if action == "forward":
            return api.forward_message(
                message_id=args.get("message_id", ""),
                to=args.get("to", ""),
                body=args.get("body", ""),
                confirmation_token=args.get("confirmation_token", ""),
                confirmed=bool(args.get("confirmed", False)),
            )
        if action == "trash":
            return api.trash_message(
                message_id=args.get("message_id", ""),
                confirmation_token=args.get("confirmation_token", ""),
                confirmed=bool(args.get("confirmed", False)),
            )
        if action == "delete":
            return api.delete_message(
                message_id=args.get("message_id", ""),
                confirmation_token=args.get("confirmation_token", ""),
                confirmed=bool(args.get("confirmed", False)),
            )
        return {"success": False, "error": {"code": "INVALID_ARGUMENT", "message": "未知 action"}}
