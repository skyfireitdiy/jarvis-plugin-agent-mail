"""验证邮件管理能力（文件夹/未读/附件过滤、cc/bcc/reply_all、星标、批量操作）。

场景：
1. list_messages / search_messages 的 dir / unread_only / has_attachments 参数映射到 CLI
2. send_message / forward_message 的 cc / bcc 参数映射（list 与逗号字符串）
3. reply_message 的 reply_all 与 cc/bcc
4. set_starred / list_starred 持久化，且列表结果合并 starred 字段
5. batch_message_action：read/unread 本地覆盖、star/unstar 本地、trash/delete 逐封调 CLI
6. PUBLIC_FUNCTIONS 包含新增函数
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


# ---------- CLI mock ----------
_orig_run_cli = api._run_cli
captured = []


def fake_run_cli(args, timeout=60, cwd=None):
    captured.append(list(args))
    return {"success": True, "data": {"data": [], "pagination": {}}}


api._run_cli = fake_run_cli  # type: ignore


def last_args():
    return captured[-1] if captured else []


# ---------- 场景 1：list / search 参数映射 ----------
captured.clear()
api.list_messages(page=1, page_size=30, dir="sent", unread_only=True, has_attachments=True)
a = last_args()
check("list 使用 message +list", a[:2] == ["message", "+list"], str(a))
check("list 传 --limit", "--limit" in a and a[a.index("--limit") + 1] == "30")
check("list 传 --dir sent", "--dir" in a and a[a.index("--dir") + 1] == "sent")
check("list 传 --is-unread", "--is-unread" in a)
check("list 传 --has-attachments", "--has-attachments" in a)

captured.clear()
api.list_messages(folder="trash")  # 兼容旧参数 folder
a = last_args()
check("list 兼容 folder 参数映射为 --dir", "--dir" in a and a[a.index("--dir") + 1] == "trash")

captured.clear()
api.search_messages("hello", dir="inbox", unread_only=True, has_attachments=True)
a = last_args()
check("search 使用 message +search --q", a[:3] == ["message", "+search", "--q"] and "hello" in a)
check("search 传 --dir inbox", "--dir" in a and a[a.index("--dir") + 1] == "inbox")
check("search 传 --is-unread", "--is-unread" in a)
check("search 传 --has-attachments", "--has-attachments" in a)

# ---------- 场景 2：send / forward 的 cc/bcc ----------
captured.clear()
api.send_message("a@b.com", subject="s", body="b", cc=["c1@x.com", "c2@x.com"], bcc="d1@x.com,d2@x.com")
a = last_args()
check("send 传 --to", a[:3] == ["message", "+send", "--to"] and "a@b.com" in a)
cc_vals = [a[i + 1] for i, v in enumerate(a) if v == "--cc"]
bcc_vals = [a[i + 1] for i, v in enumerate(a) if v == "--bcc"]
check("send cc list 逐个 --cc", cc_vals == ["c1@x.com", "c2@x.com"], str(cc_vals))
check("send bcc 逗号串拆分 --bcc", bcc_vals == ["d1@x.com", "d2@x.com"], str(bcc_vals))

captured.clear()
api.forward_message("m-1", "to@x.com", cc="c@x.com", bcc="b@x.com")
a = last_args()
check("forward 使用 message +forward", a[:2] == ["message", "+forward"])
check("forward 传 cc/bcc", "--cc" in a and "--bcc" in a)

# ---------- 场景 3：reply_all ----------
captured.clear()
api.reply_message("m-2", body="ok", reply_all=True, cc="c@x.com")
a = last_args()
check("reply 使用 message +reply --id", a[:4] == ["message", "+reply", "--id", "m-2"], str(a))
check("reply_all 传 --reply-all", "--reply-all" in a)
check("reply 传 cc", "--cc" in a)

captured.clear()
api.reply_message("m-3", body="ok")
a = last_args()
check("reply 默认不带 --reply-all", "--reply-all" not in a)

# ---------- 场景 4：星标持久化 ----------
api._save_starred([])
res = api.set_starred("m-star-1", True)
check("set_starred 返回成功", res.get("success"))
check("list_starred 含 m-star-1", "m-star-1" in api.list_starred().get("data", []))
api.set_starred("m-star-1", False)
check("取消星标后 list_starred 不含", "m-star-1" not in api.list_starred().get("data", []))

# 列表结果合并 starred 字段
api.set_starred("m-flag", True)
norm = api._apply_local_flags({"id": "m-flag", "is_read": False})
check("_apply_local_flags 合并 starred", norm.get("starred") is True)
norm2 = api._apply_local_flags({"id": "m-other"})
check("未加星消息 starred=False", norm2.get("starred") is False)

# ---------- 场景 5：batch_message_action ----------
api._save_starred([])
api._save_unread_overrides({})

# read / unread 本地覆盖
res = api.batch_message_action(["m-a", "m-b"], "read")
check("batch read 返回成功", res.get("success") and res["data"]["succeeded"] == 2)
ov = api._load_unread_overrides()
check("batch read 写入本地覆盖", ov.get("m-a") is True and ov.get("m-b") is True)
norm = api._apply_local_flags({"id": "m-a", "is_read": False})
check("本地覆盖影响 is_read", norm.get("is_read") is True)

res = api.batch_message_action(["m-a"], "unread")
ov = api._load_unread_overrides()
check("batch unread 写入本地覆盖 False", ov.get("m-a") is False)

# star / unstar 本地
res = api.batch_message_action("m-s1,m-s2", "star")
check("batch star 支持逗号串", res.get("success") and res["data"]["succeeded"] == 2)
starred = api.list_starred().get("data", [])
check("batch star 写入星标", "m-s1" in starred and "m-s2" in starred)
api.batch_message_action(["m-s1"], "unstar")
check("batch unstar 移除星标", "m-s1" not in api.list_starred().get("data", []))

# trash / delete 逐封调 CLI，需确认参数
captured.clear()
res = api.batch_message_action(["m-t1", "m-t2"], "trash", confirmed=True)
check("batch trash 返回成功", res.get("success") and res["data"]["succeeded"] == 2)
trash_calls = [c for c in captured if "+trash" in c]
check("batch trash 逐封调 CLI", len(trash_calls) == 2)
check("batch trash 传 --confirmed", all("--confirmed" in c for c in trash_calls))

captured.clear()
res = api.batch_message_action(["m-d1"], "delete", confirmation_token="tok-1")
del_calls = [c for c in captured if "+delete" in c]
check("batch delete 传 confirmation-token",
      len(del_calls) == 1 and "--confirmation-token" in del_calls[0])

# 非法 action / 空 ids
check("batch 非法 action 报错", not api.batch_message_action(["x"], "bogus").get("success"))
check("batch 空 ids 报错", not api.batch_message_action([], "read").get("success"))

# ---------- 场景 6：PUBLIC_FUNCTIONS ----------
for fn in ("set_starred", "list_starred", "batch_message_action"):
    check(f"PUBLIC_FUNCTIONS 含 {fn}", fn in api.PUBLIC_FUNCTIONS)

# ---------- 清理 ----------
api._run_cli = _orig_run_cli
api._save_starred([])
api._save_unread_overrides({})

print("\n===== 汇总 =====")
failed = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(f"{'✅' if ok else '❌'} {name} {detail}")
print(f"\n通过 {len(results) - len(failed)}/{len(results)}")
sys.exit(1 if failed else 0)
