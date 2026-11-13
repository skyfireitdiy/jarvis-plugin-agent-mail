"""验证 agent-mail 后台轮询线程的进程角色判断。

场景：
1. 非 Agent 进程（master gateway，无 IS_AGENT_PROCESS）→ 应创建线程
2. Agent 进程（IS_AGENT_PROCESS=1）→ 不应创建线程
3. Agent 进程调用 update_settings(poll_enabled=true) → 不应创建线程
4. 非 Agent 进程调用 update_settings(poll_enabled=true) → 应创建线程
5. 关闭后线程退出（非 Agent 进程）
"""
import importlib
import os
import sys
import tempfile
import threading
import time

# 隔离数据目录，避免污染真实 settings
_TMP = tempfile.mkdtemp(prefix="agent-mail-test-")
os.environ["HOME"] = _TMP  # 让 _DATA_DIR 指向临时目录

_PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PLUGIN_DIR)

from plugin import api  # noqa: E402

_POLL_THREAD_NAME = "agent-mail-poll"


def _count_poll_threads() -> int:
    return sum(
        1 for t in threading.enumerate() if t.name == _POLL_THREAD_NAME and t.is_alive()
    )


def _reload():
    importlib.reload(api)


def _stop_and_wait(timeout=5.0):
    """停止轮询线程并等待其退出（线程在下一周期检查 poll_enabled 后退出）。"""
    api.update_settings({"poll_enabled": False})
    deadline = time.time() + timeout
    while _count_poll_threads() > 0 and time.time() < deadline:
        time.sleep(0.2)
    return _count_poll_threads() == 0


results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"{'✅' if cond else '❌'} {name} {detail}")


# ---------- 场景 1：非 Agent 进程 ----------
os.environ.pop("IS_AGENT_PROCESS", None)
_reload()
print(f"\n[场景1] 非 Agent 进程，_is_agent_process()={api._is_agent_process()}")
check("非 Agent 进程 _is_agent_process()=False", api._is_agent_process() is False)

# 模拟 settings poll_enabled=true，用短间隔便于后续快速退出
api.update_settings({"poll_enabled": True, "poll_interval_seconds": 1})
time.sleep(0.5)
n = _count_poll_threads()
check("非 Agent 进程 update_settings 后创建线程", n == 1, f"(线程数={n})")

# ---------- 场景 2：Agent 进程 ----------
# 先清掉场景 1 的线程，隔离验证
ok_stop = _stop_and_wait()
check("清理场景1线程", ok_stop, f"(线程数={_count_poll_threads()})")

os.environ["IS_AGENT_PROCESS"] = "1"
_reload()
print(f"\n[场景2] Agent 进程，_is_agent_process()={api._is_agent_process()}")
check("Agent 进程 _is_agent_process()=True", api._is_agent_process() is True)

# Agent 进程模块加载自动恢复：不应创建线程
n = _count_poll_threads()
check("Agent 进程模块加载不创建线程", n == 0, f"(线程数={n})")

# Agent 进程调用 update_settings 也不应创建
api.update_settings({"poll_enabled": True})
time.sleep(0.5)
n = _count_poll_threads()
check("Agent 进程 update_settings 不创建线程", n == 0, f"(线程数={n})")

# ---------- 场景 3：回到非 Agent 进程，线程恢复 ----------
os.environ.pop("IS_AGENT_PROCESS", None)
_reload()
print("\n[场景3] 回到非 Agent 进程")
n = _count_poll_threads()
check("非 Agent 进程模块加载自动恢复线程", n == 1, f"(线程数={n})")

# ---------- 场景 4：关闭后线程退出 ----------
ok_stop = _stop_and_wait()
check("关闭 poll_enabled 后线程退出", ok_stop, f"(线程数={_count_poll_threads()})")

# ---------- 清理 ----------
api.update_settings({"poll_enabled": False})
print("\n===== 汇总 =====")
failed = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(f"{'✅' if ok else '❌'} {name} {detail}")
print(f"\n通过 {len(results)-len(failed)}/{len(results)}")
sys.exit(1 if failed else 0)
