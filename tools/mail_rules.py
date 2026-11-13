# -*- coding: utf-8 -*-
"""Agent Mail 规则工具（tools 扩展点，供 Agent 调用）。

封装自动处理规则的查询/创建/更新/删除，复用 plugin/api.py 的业务逻辑。
plugin/ 目录不在 sys.path，通过 importlib 按路径动态加载（模块名固定便于缓存）。
"""

from __future__ import annotations

import importlib.util
import json
import os
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


class mail_rules:
    """Agent Mail 规则工具：查询/创建/更新/删除自动处理规则。

    用途:
    - 列出全部自动处理规则
    - 新建规则（触发条件/模式/提示词模板/自动回复开关/白名单）
    - 更新规则、删除规则

    参数:
    - action (str): 操作类型，list/create/update/delete
    - rule_id (str): 规则 ID（update/delete 需要）
    - rule (object): 规则对象（create/update 需要），字段：
      name(必填)、enabled(bool)、trigger_type(sender_contains/keyword/all)、
      trigger_value、mode(analyze/auto_reply/manual_confirm)、
      prompt_template(支持 {subject}{sender}{body}{message_id}{attachments})、
      auto_reply(bool，默认 false)、reply_scope(sender/whitelist)、whitelist([])

    返回:
    - success (bool)
    - stdout (str): JSON 文本
    - stderr (str)
    """

    name = "mail_rules"
    description = "Agent Mail 规则工具：查询/创建/更新/删除自动处理规则。"

    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "create", "update", "delete"],
                "description": "操作类型",
            },
            "rule_id": {"type": "string", "description": "规则 ID"},
            "rule": {
                "type": "object",
                "description": "规则对象（create/update 需要）",
            },
        },
        "required": ["action"],
    }

    @staticmethod
    def check() -> bool:
        """工具可用性：规则管理为纯本地操作，始终可用。"""
        return True

    def execute(self, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            api = _load_api()
            action = args.get("action")
            if action == "list":
                result = api.list_rules()
            elif action == "create":
                rule = args.get("rule")
                if not isinstance(rule, dict):
                    return {
                        "success": False,
                        "stdout": "",
                        "stderr": "参数错误：create 需要 rule 对象",
                    }
                result = api.create_rule(rule)
            elif action == "update":
                rule_id = args.get("rule_id", "")
                updates = args.get("rule")
                if not rule_id or not isinstance(updates, dict):
                    return {
                        "success": False,
                        "stdout": "",
                        "stderr": "参数错误：update 需要 rule_id 与 rule 对象",
                    }
                result = api.update_rule(rule_id, updates)
            elif action == "delete":
                rule_id = args.get("rule_id", "")
                if not rule_id:
                    return {
                        "success": False,
                        "stdout": "",
                        "stderr": "参数错误：delete 需要 rule_id",
                    }
                result = api.delete_rule(rule_id)
            else:
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": "参数错误：action 必须是 list/create/update/delete",
                }

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
                "stderr": f"mail_rules 执行异常: {e}",
            }
