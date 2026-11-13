"""验证 resolve_pending 批准后派发 Agent 的行为。

场景：
1. 批准（approve）→ 调用 _spawn_agent 派发 Agent，任务从队列移除，写留痕
2. 批准但派发失败 → 任务放回队列（保留待处理状态供重试）
3. 拒绝（reject）→ 任务从队列移除，写留痕
4. 删除（delete）→ 任务从队列移除
5. 任务不存在 → 报错
"""
import os
import sys
import tempfile
import uuid
from typing import Any
from typing import Dict

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


def _make_pending(rule_id="rule-1", rule_name="测试规则", message_id="msg-1"):
    return {
        "id": str(uuid.uuid4()),
        "message_id": message_id,
        "sender": "a@b.com",
        "subject": "测试主题",
        "rule_id": rule_id,
        "rule_name": rule_name,
        "mode": "manual_confirm",
        "status": "pending",
        "prompt": "请处理这封邮件",
        "created_at": api._now(),
    }


def _seed_pending(items):
    api._save_pending(items)
    return items


def _load_pending():
    return api._load_pending()


# ---------- 场景 1：批准成功派发 ----------
# mock _spawn_agent 记录调用，模拟成功
spawn_calls = []
orig_spawn = api._spawn_agent


def fake_spawn_success(task: str, message_id: str, rule: Dict[str, Any]) -> Dict[str, Any]:
    spawn_calls.append({"task": task, "message_id": message_id, "rule": rule})
    return {"success": True, "data": {"dispatched": "agent", "agent_id": "agent-123", "message_id": message_id}}


api._spawn_agent = fake_spawn_success  # type: ignore
item = _make_pending()
_seed_pending([item])
res = api.resolve_pending(item["id"], "approve")
check("批准成功返回 dispatched=agent", res.get("success") and res.get("data", {}).get("dispatched") == "agent")
check("批准后 _spawn_agent 被调用", len(spawn_calls) == 1)
check("派发使用任务里存的 prompt", spawn_calls and spawn_calls[0]["task"] == "请处理这封邮件")
check("派发使用任务的 message_id", spawn_calls and spawn_calls[0]["message_id"] == "msg-1")
check("批准后任务从队列移除", len(_load_pending()) == 0)
hist = api._load_history()
check("批准写留痕 pending_approved", any(h.get("kind") == "pending_approved" for h in hist))

# ---------- 场景 2：批准但派发失败 → 任务放回队列 ----------
spawn_calls.clear()


def fake_spawn_fail(task: str, message_id: str, rule: Dict[str, Any]) -> Dict[str, Any]:
    spawn_calls.append({"task": task, "message_id": message_id, "rule": rule})
    return {"success": False, "error": {"code": "AGENT_DISPATCH_FAILED", "message": "模拟失败"}}


api._spawn_agent = fake_spawn_fail  # type: ignore
item2 = _make_pending(message_id="msg-2")
_seed_pending([item2])
res = api.resolve_pending(item2["id"], "approve")
check("派发失败返回错误", not res.get("success"))
check("派发失败后任务放回队列", len(_load_pending()) == 1 and _load_pending()[0]["id"] == item2["id"])
check("放回队列的任务状态恢复 pending", _load_pending()[0]["status"] == "pending")

# ---------- 场景 3：拒绝 → 移除 + 留痕 ----------
api._spawn_agent = orig_spawn
item3 = _make_pending(message_id="msg-3")
_seed_pending([item3])
res = api.resolve_pending(item3["id"], "reject")
check("拒绝返回成功", res.get("success"))
check("拒绝后任务从队列移除", len(_load_pending()) == 0)
hist = api._load_history()
check("拒绝写留痕 pending_rejected", any(h.get("kind") == "pending_rejected" for h in hist))

# ---------- 场景 4：删除 → 移除 ----------
item4 = _make_pending(message_id="msg-4")
_seed_pending([item4])
res = api.resolve_pending(item4["id"], "delete")
check("删除返回成功", res.get("success"))
check("删除后任务从队列移除", len(_load_pending()) == 0)

# ---------- 场景 5：任务不存在 ----------
res = api.resolve_pending("not-exist", "approve")
check("任务不存在报错", not res.get("success"))

# ---------- 清理 ----------
api._save_pending([])
print("\n===== 汇总 =====")
failed = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(f"{'✅' if ok else '❌'} {name} {detail}")
print(f"\n通过 {len(results)-len(failed)}/{len(results)}")
sys.exit(1 if failed else 0)
