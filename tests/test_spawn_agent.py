"""验证 _spawn_agent 从 create_agent_threadsafe 返回字典中正确提取 agent_id。

场景：
1. 返回 dict 含 agent_id → 提取字符串 agent_id
2. 返回 dict 缺 agent_id → 回退空字符串
3. 返回非 dict → 转字符串
4. AgentManager 不可用 → 报错
"""
import os
import sys
import tempfile

# 隔离数据目录，避免污染真实 settings
_TMP = tempfile.mkdtemp(prefix="agent-mail-test-")
os.environ["HOME"] = _TMP  # 让 _DATA_DIR 指向临时目录

_PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PLUGIN_DIR)

from plugin import api  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"{'✅' if cond else '❌'} {name} {detail}")


# mock _get_agent_manager 返回假 manager
class FakeManager:
    def __init__(self, return_value):
        self.return_value = return_value
        self.calls = []

    def create_agent_threadsafe(self, **kwargs):
        self.calls.append(kwargs)
        return self.return_value


# ---------- 场景 1：返回 dict 含 agent_id ----------
fm = FakeManager({"agent_id": "abc-123", "status": "running", "name": "mail-test"})
api._get_agent_manager = lambda: fm  # type: ignore
res = api._spawn_agent("任务", "msg-1", {"id": "rule-1", "name": "规则"})
check("返回 dict 时提取 agent_id", res.get("success") and res.get("data", {}).get("agent_id") == "abc-123")
check("agent_id 是字符串而非整个 dict", isinstance(res.get("data", {}).get("agent_id"), str) and len(res["data"]["agent_id"]) < 50)
check("派发参数正确", fm.calls and fm.calls[0]["task"] == "任务" and fm.calls[0]["name"] == "mail-msg-1")
check("additional_args 带 message_id 和 rule_id", fm.calls and fm.calls[0]["additional_args"] == {"agent_mail": {"message_id": "msg-1", "rule_id": "rule-1"}})

# ---------- 场景 2：返回 dict 缺 agent_id ----------
fm2 = FakeManager({"status": "running"})
api._get_agent_manager = lambda: fm2  # type: ignore
res = api._spawn_agent("任务", "msg-2", {"id": "rule-2"})
check("缺 agent_id 时回退空字符串", res.get("success") and res.get("data", {}).get("agent_id") == "")

# ---------- 场景 3：返回非 dict ----------
fm3 = FakeManager("plain-string-id")
api._get_agent_manager = lambda: fm3  # type: ignore
res = api._spawn_agent("任务", "msg-3", {"id": "rule-3"})
check("非 dict 时转字符串", res.get("success") and res.get("data", {}).get("agent_id") == "plain-string-id")

# ---------- 场景 4：AgentManager 不可用 ----------
api._get_agent_manager = lambda: None  # type: ignore
res = api._spawn_agent("任务", "msg-4", {"id": "rule-4"})
check("AgentManager 不可用时报错", not res.get("success"))

# ---------- 清理 ----------
print("\n===== 汇总 =====")
failed = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(f"{'✅' if ok else '❌'} {name} {detail}")
print(f"\n通过 {len(results)-len(failed)}/{len(results)}")
sys.exit(1 if failed else 0)
