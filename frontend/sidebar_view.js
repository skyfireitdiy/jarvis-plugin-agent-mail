// Agent Mail 插件 - 侧边栏视图（对齐主流邮件客户端的收发体验）。
// 约定：纯浏览器 ES module，用 window.Vue 渲染，导出 default 组件，不 import 'vue'。
// 功能：文件夹切换、未读/星标、多选批量操作、邮件详情操作栏（回复/回复全部/转发）、
//      写信（抄送/密送/附件）、处理留痕与待确认队列。
// 认证：通过 window.__jarvisFetch 调用 gateway 插件功能代理端点，不直接访问邮箱服务。

const PLUGIN = "agent-mail";

// 文件夹定义（dir 与 agently-cli --dir 一致）
const FOLDERS = [
  { dir: "inbox", label: "收件箱" },
  { dir: "sent", label: "已发送" },
  { dir: "trash", label: "回收站" },
  { dir: "spam", label: "垃圾邮件" },
];

// 规范化主题：去掉 Re:/Fw:/Fwd:/回复:/转发: 等前缀（可重复嵌套），用于会话归组
function normalizeSubject(subject) {
  let s = String(subject || "").trim();
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/^(re|fw|fwd|回复|答复|转发|转交|自动回复)\s*[:：]\s*/i, "")
      .replace(/^\s*\[[^\]]*\]\s*/, "")
      .trim();
  }
  return s;
}
// 会话归组：同主题（去前缀）视为一个会话
function threadContact(m) {
  return (m && m.from_email) || (m && m.from) || (m && m.sender) || "未知";
}
function threadKey(m) {
  return normalizeSubject(m.subject);
}
// 把地址数组（[{email,name}] 或字符串数组）转成逗号分隔字符串
function addrToString(list) {
  if (!list) return "";
  if (typeof list === "string") return list;
  if (!Array.isArray(list)) return String(list);
  return list
    .map((it) =>
      it && typeof it === "object" ? it.email || it.name || "" : String(it || ""),
    )
    .filter(Boolean)
    .join(", ");
}
// 格式化时间为简洁显示（今天显示 HH:MM，否则 MM-DD）
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const pad = (n) => String(n).padStart(2, "0");
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 解析 gateway 地址（与 App.vue 一致）
function parseGatewayAddress(address) {
  address = (address || "").trim();
  if (!address) return null;
  if (address.includes("://")) {
    try {
      const url = new URL(address);
      return {
        protocol: url.protocol.replace(":", ""),
        host: url.hostname,
        port:
          url.port ||
          (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80"),
        path: url.pathname,
      };
    } catch {
      return null;
    }
  }
  if (address.includes(":")) {
    const parts = address.split(":");
    if (parts.length === 2) {
      return { protocol: null, host: parts[0], port: parts[1], path: "" };
    }
  }
  return { protocol: null, host: address, port: "8000", path: "" };
}
function getHttpProtocol() {
  return window.location.protocol === "https:" ? "https" : "http";
}
function gatewayBase() {
  const parsed = parseGatewayAddress(
    localStorage.getItem("jarvis_gateway_url") || "",
  );
  const host = (parsed && parsed.host) || "127.0.0.1";
  const port = (parsed && parsed.port) || "8000";
  const protocol =
    parsed && parsed.protocol === "https" ? "https" : getHttpProtocol();
  return `${protocol}://${host}:${port}`;
}

// 调用插件私有功能
async function callFunction(functionName, args, nodeId) {
  const authedFetch =
    (typeof window !== "undefined" && window.__jarvisFetch) || fetch;
  const targetNodeId = String(nodeId || "master").trim() || "master";
  const resp = await authedFetch(
    `${gatewayBase()}/api/plugins/${encodeURIComponent(targetNodeId)}/function-call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plugin: PLUGIN,
        function: functionName,
        arguments: args || {},
      }),
    },
  );
  let result;
  try {
    result = await resp.json();
  } catch (e) {
    throw new Error("网关响应异常", { cause: e });
  }
  if (!result.success) {
    const err = result.error || {};
    throw new Error(err.message || err.code || "调用失败");
  }
  const payload = result.result || {};
  if (payload.success === false) {
    const perr = payload.error || {};
    throw new Error(
      (perr && perr.message) || (typeof perr === "string" ? perr : "") || "操作失败",
    );
  }
  return payload;
}

export default {
  name: "AgentMailSidebarView",
  props: {
    workingDir: { type: String, default: "" },
  },
  data() {
    return {
      // 紧凑按钮样式（参考其他插件，避免浏览器默认大按钮）
      btnBase:
        "padding:3px 8px;background:var(--color-bg-tertiary);color:var(--color-text-primary);border:1px solid var(--color-border-subtle);border-radius:4px;cursor:pointer;font-size:11px;",
      btnPrimary:
        "padding:4px 10px;background:var(--color-accent);color:#060911;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;",
      btnDanger:
        "padding:3px 8px;background:var(--color-bg-tertiary);color:var(--color-error);border:1px solid var(--color-border-subtle);border-radius:4px;cursor:pointer;font-size:11px;",
      folders: FOLDERS,
      loading: false,
      error: "",
      tab: "inbox", // inbox / history / pending / tools
      toolTab: "send", // send / reply / forward / manage（工具面板内部）
      // 收件箱
      folder: "inbox",
      messages: [],
      selected: null,
      page: 1,
      pageSize: 20,
      searchQuery: "",
      unreadOnly: false,
      // 多选
      selectedIds: {},
      // 写信/回复/转发
      compose: null, // {mode, to, cc, bcc, subject, body, message_id, attachments:[]}
      // 工具（发送/回复/转发/管理）
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      body: "",
      messageId: "",
      confirmed: false,
      result: "",
      // 会话（按主题+联系人归组）展开状态
      expandedThreads: {},
      // 留痕
      history: [],
      // 待确认
      pending: [],
    };
  },
  computed: {
    selectedBody() {
      const m = this.selected || {};
      const raw = m.body || m.snippet || m.content || "（无正文）";
      // 邮件正文可能是 HTML，剥离标签转纯文本（防 XSS，避免显示源码）
      if (typeof raw !== "string") return String(raw);
      if (raw.includes("<")) {
        const doc = new DOMParser().parseFromString(raw, "text/html");
        // 移除 style/script/head 内容，避免 CSS/JS 文本混入正文
        doc.querySelectorAll("style, script, head, title").forEach((el) => el.remove());
        // 移除内联 display:none 的元素（如 PC/移动双版本邮件中隐藏的那套），避免重复段落
        doc.querySelectorAll("*").forEach((el) => {
          const s = (el.getAttribute("style") || "").toLowerCase();
          if (s.includes("display:none") || s.includes("display: none")) {
            el.remove();
          }
        });
        let text = doc.body ? doc.body.textContent || "" : "";
        text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        return text || raw;
      }
      return raw;
    },
    // 会话分组：同主题（去前缀）归为一组，按最新邮件时间倒序
    threads() {
      const groups = new Map();
      for (const m of this.messages) {
        const key = threadKey(m);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const list = [];
      for (const [key, msgs] of groups) {
        msgs.sort((a, b) =>
          String(a.created_at || "").localeCompare(String(b.created_at || "")),
        );
        const latest = msgs[msgs.length - 1];
        list.push({
          key,
          subject: normalizeSubject(msgs[0].subject) || msgs[0].subject,
          contact: threadContact(latest),
          messages: msgs,
          count: msgs.length,
          latest,
          unread: msgs.some((m) => m.is_read === false),
          starred: msgs.some((m) => m.starred === true),
        });
      }
      list.sort((a, b) =>
        String(b.latest.created_at || "").localeCompare(
          String(a.latest.created_at || ""),
        ),
      );
      return list;
    },
    unreadCount() {
      return this.messages.filter((m) => m.is_read === false).length;
    },
    selectedCount() {
      return Object.keys(this.selectedIds).filter((k) => this.selectedIds[k]).length;
    },
    selectedIdList() {
      return Object.keys(this.selectedIds).filter((k) => this.selectedIds[k]);
    },
    allSelected() {
      return this.messages.length > 0 && this.selectedCount === this.messages.length;
    },
  },
  methods: {
    fmtTime,
    addrToString,
    isThreadExpanded(key) {
      return this.expandedThreads[key] === true;
    },
    toast(msg, type) {
      if (typeof window !== "undefined" && window.__jarvisShowToast) {
        window.__jarvisShowToast(msg, type || "success");
      }
    },
    async guard(fn) {
      this.error = "";
      this.loading = true;
      try {
        await fn();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },
    async loadMessages(silent) {
      await this.guard(async () => {
        const payload = await callFunction("list_messages", {
          page: this.page,
          page_size: this.pageSize,
          dir: this.folder,
          unread_only: this.unreadOnly,
        });
        const data = payload.data || {};
        this.messages = data.messages || data.items || data.list || [];
        this.selectedIds = {};
        if (!silent && this.messages.length === 0 && this.error === "") {
          this.error =
            "当前文件夹为空，或未安装 agently-cli / 未登录。请先在管理设置中检查授权状态。";
        }
      });
    },
    async switchFolder(dir) {
      this.folder = dir;
      this.page = 1;
      this.searchQuery = "";
      this.selected = null;
      await this.loadMessages();
    },
    async openMessage(msg) {
      await this.guard(async () => {
        const payload = await callFunction("read_message", {
          message_id: msg.id,
        });
        this.selected = payload.data || msg;
      });
    },
    // 下载附件到插件数据目录 attachments/（大附件无 attachment_id 时提示用链接）
    async downloadAttachment(att) {
      const msg = this.selected || {};
      const attId = att.attachment_id || att.id || "";
      if (!attId) {
        const url = att.download_url || "";
        if (url) {
          this.toast("大附件不支持直接下载，请点击链接在浏览器中打开", "info");
          window.open(url, "_blank");
        } else {
          this.toast("该附件缺少 attachment_id，无法下载", "error");
        }
        return;
      }
      await this.guard(async () => {
        const payload = await callFunction("download_attachment", {
          message_id: msg.id || msg.message_id,
          attachment_id: attId,
        });
        const data = payload.data || {};
        const saved = data.path || data.file || data.filename || "";
        this.toast(saved ? `附件已下载：${saved}` : "附件已下载", "success");
      });
    },
    async search() {
      this.page = 1;
      if (!this.searchQuery.trim()) {
        return this.loadMessages();
      }
      await this.guard(async () => {
        const payload = await callFunction("search_messages", {
          query: this.searchQuery.trim(),
          page: this.page,
          page_size: this.pageSize,
          dir: this.folder,
          unread_only: this.unreadOnly,
        });
        const data = payload.data || {};
        this.messages = data.messages || data.items || data.list || [];
        this.selectedIds = {};
      });
    },
    async loadHistory() {
      await this.guard(async () => {
        const payload = await callFunction("list_history", { limit: 50 });
        this.history = payload.data || [];
      });
    },
    async loadPending() {
      await this.guard(async () => {
        const payload = await callFunction("list_pending", {});
        this.pending = payload.data || [];
      });
    },
    async switchTab(tab) {
      this.tab = tab;
      this.selected = null;
      this.compose = null;
      if (tab === "inbox") await this.loadMessages();
      else if (tab === "history") await this.loadHistory();
      else if (tab === "pending") await this.loadPending();
    },
    async resolvePending(item, action) {
      const ok = window.__jarvisConfirm
        ? await window.__jarvisConfirm(
            `确认对邮件「${item.subject || item.message_id}」执行「${action}」操作？`,
            { defaultConfirm: false },
          )
        : confirm(`确认执行「${action}」？`);
      if (!ok) return;
      await this.guard(async () => {
        await callFunction("resolve_pending", {
          pending_id: item.id,
          action: action,
        });
        this.toast(`待确认任务已${action}`);
        await this.loadPending();
      });
    },
    async refresh() {
      await this.switchTab(this.tab);
    },
    async openManage() {
      this.toolTab = "manage";
      if (this.messages.length === 0) await this.loadMessages(true);
    },
    toggleThread(key) {
      this.expandedThreads[key] = !this.isThreadExpanded(key);
    },
    // ---- 星标 / 多选 / 批量 ----
    isSelected(id) {
      return this.selectedIds[id] === true;
    },
    toggleSelect(id) {
      this.selectedIds = { ...this.selectedIds, [id]: !this.isSelected(id) };
    },
    toggleSelectAll() {
      if (this.allSelected) {
        this.selectedIds = {};
      } else {
        const next = {};
        for (const m of this.messages) next[m.id] = true;
        this.selectedIds = next;
      }
    },
    async toggleStar(m) {
      const target = !m.starred;
      await this.guard(async () => {
        await callFunction("set_starred", { message_id: m.id, starred: target });
        m.starred = target;
        if (this.selected && this.selected.id === m.id) this.selected.starred = target;
      });
    },
    async batchAction(action) {
      const ids = this.selectedIdList;
      if (!ids.length) return;
      const labels = {
        read: "标记已读",
        unread: "标记未读",
        star: "加星",
        unstar: "取消星",
        trash: "移入回收站",
        delete: "永久删除",
      };
      if (action === "trash" || action === "delete") {
        const tip =
          action === "delete"
            ? `永久删除选中的 ${ids.length} 封邮件？此操作不可恢复！`
            : `将选中的 ${ids.length} 封邮件移入回收站？`;
        const ok = window.__jarvisConfirm
          ? await window.__jarvisConfirm(tip, { defaultConfirm: false })
          : confirm(tip);
        if (!ok) return;
      }
      await this.guard(async () => {
        await callFunction("batch_message_action", {
          message_ids: ids,
          action: action,
          confirmed: true,
        });
        this.toast(`已${labels[action] || action}：${ids.length} 封`);
        await this.loadMessages(true);
      });
    },
    // ---- 写信 / 回复 / 转发 ----
    openCompose(mode, msg) {
      const m = msg || this.selected || {};
      const base = {
        mode,
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        body: "",
        message_id: m.id || m.message_id || "",
        attachments: [],
      };
      if (mode === "send") {
        this.compose = base;
      } else if (mode === "reply" || mode === "reply_all") {
        base.to = m.from_email || m.sender || "";
        base.subject = /^re\s*[:：]/i.test(m.subject || "")
          ? m.subject
          : `Re: ${m.subject || ""}`;
        if (mode === "reply_all") {
          const others = (m.to || [])
            .map((it) =>
              it && typeof it === "object" ? it.email : String(it || ""),
            )
            .filter((e) => e && e !== base.to);
          base.cc = others.join(", ");
        }
        base.body = `\n\n---------- 原邮件 ----------\n发件人：${
          m.sender || m.from || ""
        }\n时间：${m.created_at || ""}\n\n${m.body || m.snippet || ""}`;
        this.compose = base;
      } else if (mode === "forward") {
        base.subject = /^fw(d)?\s*[:：]/i.test(m.subject || "")
          ? m.subject
          : `Fw: ${m.subject || ""}`;
        base.body = `\n\n---------- 转发邮件 ----------\n发件人：${
          m.sender || m.from || ""
        }\n时间：${m.created_at || ""}\n\n${m.body || m.snippet || ""}`;
        this.compose = base;
      }
      this.tab = "inbox";
    },
    cancelCompose() {
      this.compose = null;
    },
    readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
    },
    async onPickAttachments(event) {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (!files.length || !this.compose) return;
      for (const file of files) {
        try {
          const data = await this.readFileAsDataUrl(file);
          const payload = await callFunction("upload_attachment", {
            filename: file.name,
            data,
          });
          const info = (payload && payload.data) || {};
          if (info.filename) {
            this.compose.attachments.push(info.filename);
            this.toast(`已添加附件：${info.filename}`);
          } else {
            this.error = `上传失败：${file.name}`;
          }
        } catch (e) {
          this.error = `上传失败 ${file.name}：${e.message || e}`;
        }
      }
    },
    removeComposeAttachment(name) {
      if (!this.compose) return;
      this.compose.attachments = this.compose.attachments.filter((n) => n !== name);
    },
    async submitCompose() {
      const c = this.compose;
      if (!c) return;
      if (!c.to.trim()) {
        this.error = "请填写收件人";
        return;
      }
      if (c.mode !== "forward" && !c.body.trim()) {
        this.error = "请填写正文";
        return;
      }
      const attachments = c.attachments.length ? c.attachments.slice() : undefined;
      const cc = c.cc.trim() || undefined;
      const bcc = c.bcc.trim() || undefined;
      await this.guard(async () => {
        let payload;
        if (c.mode === "send") {
          payload = await callFunction("send_message", {
            to: c.to.trim(),
            cc,
            bcc,
            subject: c.subject,
            body: c.body,
            attachments,
            confirmed: true,
          });
        } else if (c.mode === "forward") {
          payload = await callFunction("forward_message", {
            message_id: c.message_id,
            to: c.to.trim(),
            cc,
            bcc,
            body: c.body,
            attachments,
            confirmed: true,
          });
        } else {
          payload = await callFunction("reply_message", {
            message_id: c.message_id,
            body: c.body,
            cc,
            bcc,
            attachments,
            reply_all: c.mode === "reply_all",
            confirmed: true,
          });
        }
        this.result = JSON.stringify(payload.data || payload, null, 2);
        this.toast(
          c.mode === "send"
            ? "邮件已发送"
            : c.mode === "forward"
              ? "邮件已转发"
              : "回复已发送",
        );
        this.compose = null;
        this.selected = null;
        await this.loadMessages(true);
      });
    },
    // ---- 详情页快捷操作 ----
    async quickTrash() {
      const m = this.selected;
      if (!m) return;
      const ok = window.__jarvisConfirm
        ? await window.__jarvisConfirm("将该邮件移入回收站？", { defaultConfirm: true })
        : confirm("将该邮件移入回收站？");
      if (!ok) return;
      await this.guard(async () => {
        await callFunction("trash_message", { message_id: m.id, confirmed: true });
        this.toast("已移入回收站");
        this.selected = null;
        await this.loadMessages(true);
      });
    },
    async quickDelete() {
      const m = this.selected;
      if (!m) return;
      const ok = window.__jarvisConfirm
        ? await window.__jarvisConfirm("永久删除该邮件？此操作不可恢复！", {
            defaultConfirm: false,
          })
        : confirm("永久删除该邮件？此操作不可恢复！");
      if (!ok) return;
      await this.guard(async () => {
        await callFunction("delete_message", { message_id: m.id, confirmed: true });
        this.toast("邮件已删除");
        this.selected = null;
        await this.loadMessages(true);
      });
    },
    // ---- 工具：发送/回复/转发/管理（手动表单） ----
    async doSend() {
      if (!this.to.trim()) {
        this.error = "请填写收件人";
        return;
      }
      await this.guard(async () => {
        const payload = await callFunction("send_message", {
          to: this.to.trim(),
          cc: this.cc.trim() || undefined,
          bcc: this.bcc.trim() || undefined,
          subject: this.subject,
          body: this.body,
          confirmed: this.confirmed,
        });
        this.result = JSON.stringify(payload.data || payload, null, 2);
        this.toast("邮件已发送");
      });
    },
    async doReply() {
      if (!this.messageId.trim() || !this.body.trim()) {
        this.error = "请填写 message_id 与回复正文";
        return;
      }
      await this.guard(async () => {
        const payload = await callFunction("reply_message", {
          message_id: this.messageId.trim(),
          body: this.body,
          cc: this.cc.trim() || undefined,
          bcc: this.bcc.trim() || undefined,
          confirmed: this.confirmed,
        });
        this.result = JSON.stringify(payload.data || payload, null, 2);
        this.toast("回复已发送");
      });
    },
    async doForward() {
      if (!this.messageId.trim() || !this.to.trim()) {
        this.error = "请填写 message_id 与收件人";
        return;
      }
      await this.guard(async () => {
        const payload = await callFunction("forward_message", {
          message_id: this.messageId.trim(),
          to: this.to.trim(),
          body: this.body,
          confirmed: this.confirmed,
        });
        this.result = JSON.stringify(payload.data || payload, null, 2);
        this.toast("邮件已转发");
      });
    },
    async doTrash() {
      if (!this.messageId.trim()) {
        this.error = "请填写 message_id";
        return;
      }
      await this.guard(async () => {
        const payload = await callFunction("trash_message", {
          message_id: this.messageId.trim(),
          confirmed: this.confirmed,
        });
        this.result = JSON.stringify(payload.data || payload, null, 2);
        this.toast("邮件已移入回收站");
      });
    },
    async doDelete() {
      if (!this.messageId.trim()) {
        this.error = "请填写 message_id";
        return;
      }
      const ok = window.__jarvisConfirm
        ? await window.__jarvisConfirm("永久删除该邮件？此操作不可恢复！", {
            defaultConfirm: false,
          })
        : confirm("永久删除该邮件？此操作不可恢复！");
      if (!ok) return;
      await this.guard(async () => {
        const payload = await callFunction("delete_message", {
          message_id: this.messageId.trim(),
          confirmed: this.confirmed,
        });
        this.result = JSON.stringify(payload.data || payload, null, 2);
        this.toast("邮件已删除");
      });
    },
  },
  mounted() {
    this.loadMessages();
  },
  template: `
  <div class="agent-mail-sidebar" style="height:100%;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong>📬 Agent Mail</strong>
      <span style="display:flex;gap:6px;align-items:center;">
        <button :style="btnPrimary" @click="openCompose('send')">✏️ 写信</button>
        <button :style="btnBase" @click="refresh" :disabled="loading">刷新</button>
      </span>
    </div>
    <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">
      <button :style="tab==='inbox'?btnPrimary:btnBase" @click="switchTab('inbox')">邮件</button>
      <button :style="tab==='history'?btnPrimary:btnBase" @click="switchTab('history')">留痕</button>
      <button :style="tab==='pending'?btnPrimary:btnBase" @click="switchTab('pending')">待确认</button>
      <button :style="tab==='tools'?btnPrimary:btnBase" @click="switchTab('tools')">工具</button>
    </div>
    <div v-if="error" class="jarvis-alert" style="color:var(--color-error);font-size:12px;margin-bottom:8px;">{{ error }}</div>
    <div v-if="loading" style="color:var(--color-text-secondary);font-size:12px;">加载中…</div>

    <div v-if="tab==='inbox'">
      <!-- 写信 / 回复 / 转发 -->
      <div v-if="compose">
        <div style="font-size:12px;font-weight:bold;margin-bottom:6px;">
          {{ compose.mode==='send' ? '写信' : compose.mode==='forward' ? '转发' : (compose.mode==='reply_all' ? '回复全部' : '回复') }}
        </div>
        <div style="margin-bottom:6px;">
          <div style="font-size:11px;color:var(--color-text-secondary);margin-bottom:2px;">收件人</div>
          <input class="jarvis-input" v-model="compose.to" placeholder="收件人邮箱（多个用逗号分隔）" style="width:100%;box-sizing:border-box;" />
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <div style="flex:1;">
            <div style="font-size:11px;color:var(--color-text-secondary);margin-bottom:2px;">抄送</div>
            <input class="jarvis-input" v-model="compose.cc" placeholder="抄送（可选）" style="width:100%;box-sizing:border-box;" />
          </div>
          <div style="flex:1;">
            <div style="font-size:11px;color:var(--color-text-secondary);margin-bottom:2px;">密送</div>
            <input class="jarvis-input" v-model="compose.bcc" placeholder="密送（可选）" style="width:100%;box-sizing:border-box;" />
          </div>
        </div>
        <div style="margin-bottom:6px;">
          <div style="font-size:11px;color:var(--color-text-secondary);margin-bottom:2px;">主题</div>
          <input class="jarvis-input" v-model="compose.subject" placeholder="主题" style="width:100%;box-sizing:border-box;" />
        </div>
        <div style="margin-bottom:6px;">
          <div style="font-size:11px;color:var(--color-text-secondary);margin-bottom:2px;">正文</div>
          <textarea class="jarvis-input" v-model="compose.body" rows="8" placeholder="邮件正文" style="width:100%;box-sizing:border-box;"></textarea>
        </div>
        <div style="margin-bottom:6px;">
          <button :style="btnBase" @click="$refs.composeAttInput.click()">📎 添加附件</button>
          <input ref="composeAttInput" type="file" multiple style="display:none;" @change="onPickAttachments" />
          <span v-if="compose.attachments.length" style="font-size:11px;color:var(--color-text-secondary);margin-left:6px;">{{ compose.attachments.length }} 个附件</span>
        </div>
        <div v-if="compose.attachments.length" style="margin-bottom:6px;">
          <span v-for="name in compose.attachments" :key="name"
                style="display:inline-block;background:var(--color-bg-tertiary);border:1px solid var(--color-border-subtle);border-radius:4px;padding:2px 6px;margin:0 4px 4px 0;font-size:11px;">
            {{ name }} <a href="javascript:void(0)" @click="removeComposeAttachment(name)" style="color:var(--color-error);">✕</a>
          </span>
        </div>
        <div style="display:flex;gap:6px;">
          <button :style="btnPrimary" @click="submitCompose" :disabled="loading">发送</button>
          <button :style="btnBase" @click="cancelCompose">取消</button>
        </div>
      </div>

      <!-- 详情 -->
      <div v-else-if="selected">
        <button :style="btnBase" @click="selected=null" style="margin-bottom:6px;">← 返回列表</button>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <button :style="btnPrimary" @click="openCompose('reply', selected)">回复</button>
          <button :style="btnBase" @click="openCompose('reply_all', selected)">回复全部</button>
          <button :style="btnBase" @click="openCompose('forward', selected)">转发</button>
          <button :style="btnBase" @click="toggleStar(selected)">{{ selected.starred ? '★ 已加星' : '☆ 加星' }}</button>
          <button :style="btnBase" @click="quickTrash">移入回收站</button>
          <button :style="btnDanger" @click="quickDelete">永久删除</button>
        </div>
        <div style="border:1px solid var(--color-border);border-radius:6px;padding:8px;font-size:12px;">
          <div><strong>{{ selected.subject || '（无主题）' }}</strong></div>
          <div style="color:var(--color-text-secondary);">发件人：{{ selected.from_name ? (selected.from_name + ' <' + selected.from_email + '>') : (selected.sender || selected.from || '未知') }}</div>
          <div v-if="selected.to && selected.to.length" style="color:var(--color-text-secondary);">收件人：{{ addrToString(selected.to) }}</div>
          <div v-if="selected.cc && selected.cc.length" style="color:var(--color-text-secondary);">抄送：{{ addrToString(selected.cc) }}</div>
          <div style="color:var(--color-text-secondary);">时间：{{ selected.created_at || '-' }}</div>
          <div v-if="selected.attachments && selected.attachments.length" style="color:var(--color-text-secondary);margin-top:4px;">
            <div style="margin-bottom:4px;">附件：</div>
            <div v-for="att in selected.attachments" :key="att.attachment_id || att.id || att.filename || att.name"
                 style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">
              <span>{{ att.filename || att.name || '未命名附件' }}</span>
              <span v-if="att.size" style="font-size:10px;opacity:0.8;">{{ (att.size/1024).toFixed(1) }}KB</span>
              <button :style="btnBase" @click="downloadAttachment(att)" :disabled="loading">下载</button>
            </div>
          </div>
          <pre style="white-space:pre-wrap;word-break:break-word;margin-top:6px;font-family:inherit;">{{ selectedBody }}</pre>
        </div>
      </div>

      <!-- 列表 -->
      <div v-else>
        <!-- 文件夹切换 + 未读过滤 -->
        <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;align-items:center;">
          <button v-for="f in folders" :key="f.dir"
                  :style="folder===f.dir?btnPrimary:btnBase"
                  @click="switchFolder(f.dir)">{{ f.label }}</button>
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--color-text-secondary);margin-left:auto;">
            <input type="checkbox" v-model="unreadOnly" @change="loadMessages()" /> 仅未读
          </label>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <input class="jarvis-input" v-model="searchQuery" placeholder="搜索邮件…" @keyup.enter="search" style="flex:1;" />
          <button :style="btnBase" @click="search">搜索</button>
        </div>
        <!-- 批量操作栏 -->
        <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--color-text-secondary);">
          <label style="display:flex;align-items:center;gap:4px;">
            <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" /> 全选
          </label>
          <span v-if="unreadCount>0" style="color:var(--color-accent);">未读 {{ unreadCount }}</span>
          <span v-if="selectedCount>0" style="margin-left:auto;display:flex;gap:4px;flex-wrap:wrap;">
            <button :style="btnBase" @click="batchAction('read')">已读</button>
            <button :style="btnBase" @click="batchAction('unread')">未读</button>
            <button :style="btnBase" @click="batchAction('star')">★</button>
            <button :style="btnBase" @click="batchAction('unstar')">☆</button>
            <button :style="btnBase" @click="batchAction('trash')">移入回收站</button>
            <button :style="btnDanger" @click="batchAction('delete')">删除</button>
          </span>
        </div>
        <div v-if="threads.length===0" style="color:var(--color-text-secondary);font-size:12px;">暂无邮件</div>
        <div v-for="t in threads" :key="t.key" style="border:1px solid var(--color-border);border-radius:6px;margin-bottom:6px;overflow:hidden;">
          <div @click="toggleThread(t.key)" style="padding:6px;cursor:pointer;display:flex;align-items:center;gap:6px;">
            <span style="flex-shrink:0;font-size:12px;">{{ isThreadExpanded(t.key) ? '▾' : '▸' }}</span>
            <div style="min-width:0;flex:1;">
              <div :style="t.unread ? 'font-size:12px;font-weight:bold;' : 'font-size:12px;'" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                <span v-if="t.unread" style="color:var(--color-accent);">●</span>
                <span v-if="t.starred" style="color:#f5a623;">★</span>
                {{ t.subject || '（无主题）' }}
                <span v-if="t.count>1" style="color:var(--color-text-secondary);font-weight:normal;"> ({{ t.count }})</span>
                <span v-if="t.latest.has_attachments" style="font-size:10px;">📎</span>
              </div>
              <div style="font-size:11px;color:var(--color-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {{ t.contact }} · {{ (t.latest.snippet || t.latest.body || '').slice(0, 60) }}
              </div>
            </div>
            <span style="font-size:10px;color:var(--color-text-secondary);flex-shrink:0;">{{ fmtTime(t.latest.created_at) }}</span>
          </div>
          <div v-if="isThreadExpanded(t.key)">
            <div v-for="m in t.messages" :key="m.id"
                 style="padding:5px 6px 5px 12px;border-top:1px dashed var(--color-border);display:flex;align-items:center;gap:6px;">
              <input type="checkbox" :checked="isSelected(m.id)" @change="toggleSelect(m.id)" @click.stop />
              <span @click.stop="toggleStar(m)" style="cursor:pointer;font-size:12px;" :style="m.starred ? 'color:#f5a623;' : 'color:var(--color-text-secondary);'">{{ m.starred ? '★' : '☆' }}</span>
              <div style="min-width:0;flex:1;cursor:pointer;" @click="openMessage(m)">
                <div :style="m.is_read===false ? 'font-size:11px;font-weight:bold;' : 'font-size:11px;'" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {{ m.from_name || m.sender || m.from || '未知' }}
                  <span v-if="m.has_attachments" style="font-size:10px;">📎</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ (m.snippet || m.body || '').slice(0, 80) }}</div>
              </div>
              <span style="font-size:10px;color:var(--color-text-secondary);flex-shrink:0;">{{ fmtTime(m.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 留痕 -->
    <div v-if="tab==='history'">
      <div v-if="history.length===0" style="color:var(--color-text-secondary);font-size:12px;">暂无处理留痕</div>
      <div v-for="h in history" :key="h.id" style="border:1px solid var(--color-border);border-radius:6px;padding:6px;margin-bottom:6px;font-size:12px;">
        <div><strong>{{ h.rule_name || h.kind }}</strong> <span style="color:var(--color-text-secondary);">[{{ h.status || h.kind }}]</span></div>
        <div style="color:var(--color-text-secondary);">{{ h.created_at }} · {{ h.detail || '' }}</div>
      </div>
    </div>

    <!-- 待确认 -->
    <div v-if="tab==='pending'">
      <div v-if="pending.length===0" style="color:var(--color-text-secondary);font-size:12px;">暂无待确认任务</div>
      <div v-for="p in pending" :key="p.id" style="border:1px solid var(--color-border);border-radius:6px;padding:6px;margin-bottom:6px;font-size:12px;">
        <div><strong>{{ p.subject || '（无主题）' }}</strong></div>
        <div style="color:var(--color-text-secondary);">发件人：{{ p.sender || '未知' }} · 规则：{{ p.rule_name || '-' }}</div>
        <div style="color:var(--color-text-secondary);">{{ p.created_at }}</div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button :style="btnPrimary" @click="resolvePending(p,'approve')">批准</button>
          <button :style="btnBase" @click="resolvePending(p,'reject')">拒绝</button>
          <button :style="btnDanger" @click="resolvePending(p,'delete')">删除</button>
        </div>
      </div>
    </div>
  </div>
  `,
};
