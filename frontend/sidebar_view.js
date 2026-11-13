// Agent Mail 插件 - 侧边栏收件箱视图。
// 约定：纯浏览器 ES module，用 window.Vue 渲染，导出 default 组件，不 import 'vue'。
// 功能：查看邮箱消息列表、读取邮件详情、搜索邮件、查看处理留痕与待确认队列。
// 认证：通过 window.__jarvisFetch 调用 gateway 插件功能代理端点，不直接访问邮箱服务。

const PLUGIN = "agent-mail";

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
// 会话归组：同主题（去前缀）视为一个会话，跨联系人（Gmail 风格）
function threadContact(m) {
  return (m && m.from_email) || (m && m.from) || (m && m.sender) || "未知";
}
function threadKey(m) {
  return normalizeSubject(m.subject);
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
      loading: false,
      error: "",
      tab: "inbox", // inbox / history / pending
      // 收件箱
      messages: [],
      selected: null,
      page: 1,
      pageSize: 20,
      searchQuery: "",
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
        // 折叠多余空白
        text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        return text || raw;
      }
      return raw;
    },
    // 会话分组：同联系人+同主题（去前缀）归为一组，按最新邮件时间倒序
    threads() {
      const groups = new Map();
      for (const m of this.messages) {
        const key = threadKey(m);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const list = [];
      for (const [key, msgs] of groups) {
        // 会话内按时间正序（最旧在上，Gmail 风格）
        msgs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
        const latest = msgs[msgs.length - 1];
        list.push({
          key,
          subject: normalizeSubject(msgs[0].subject),
          contact: threadContact(latest),
          messages: msgs,
          count: msgs.length,
          latest,
        });
      }
      list.sort((a, b) =>
        String(b.latest.created_at || "").localeCompare(String(a.latest.created_at || "")),
      );
      return list;
    },
    // 是否展开某会话（单封默认展开，多封默认折叠）
    isThreadExpanded(key) {
      return this.expandedThreads[key] !== false;
    },
  },
  methods: {
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
    async loadMessages() {
      await this.guard(async () => {
        const payload = await callFunction("list_messages", {
          page: this.page,
          page_size: this.pageSize,
        });
        const data = payload.data || {};
        this.messages = data.messages || data.items || data.list || [];
        if (this.messages.length === 0 && this.error === "") {
          this.error =
            "收件箱为空，或未安装 agently-cli / 未登录。请先在管理设置中检查授权状态。";
        }
      });
    },
    async openMessage(msg) {
      await this.guard(async () => {
        const payload = await callFunction("read_message", {
          message_id: msg.id,
        });
        this.selected = payload.data || msg;
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
        });
        const data = payload.data || {};
        this.messages = data.messages || data.items || data.list || [];
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
    toggleThread(key) {
      this.expandedThreads[key] = !this.isThreadExpanded(key);
    },
  },
  mounted() {
    this.loadMessages();
  },
  template: `
  <div class="agent-mail-sidebar" style="height:100%;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong>📬 Agent Mail</strong>
      <button class="jarvis-btn" @click="refresh" :disabled="loading">刷新</button>
    </div>
    <div style="margin-bottom:8px;display:flex;gap:6px;">
      <button class="jarvis-btn" :class="tab==='inbox'?'jarvis-btn-primary':''" @click="switchTab('inbox')">收件箱</button>
      <button class="jarvis-btn" :class="tab==='history'?'jarvis-btn-primary':''" @click="switchTab('history')">留痕</button>
      <button class="jarvis-btn" :class="tab==='pending'?'jarvis-btn-primary':''" @click="switchTab('pending')">待确认</button>
    </div>
    <div v-if="error" class="jarvis-alert" style="color:var(--color-error);font-size:12px;margin-bottom:8px;">{{ error }}</div>
    <div v-if="loading" style="color:var(--color-text-secondary);font-size:12px;">加载中…</div>

    <!-- 收件箱 -->
    <div v-if="tab==='inbox'">
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <input class="jarvis-input" v-model="searchQuery" placeholder="搜索邮件…" @keyup.enter="search" style="flex:1;" />
        <button class="jarvis-btn" @click="search">搜索</button>
      </div>
      <div v-if="selected">
        <button class="jarvis-btn" @click="selected=null" style="margin-bottom:6px;">← 返回列表</button>
        <div style="border:1px solid var(--color-border);border-radius:6px;padding:8px;font-size:12px;">
          <div><strong>{{ selected.subject || '（无主题）' }}</strong></div>
          <div style="color:var(--color-text-secondary);">发件人：{{ selected.sender || selected.from || '未知' }}</div>
          <div style="color:var(--color-text-secondary);">ID：{{ selected.id }}</div>
          <div v-if="selected.attachments && selected.attachments.length" style="color:var(--color-text-secondary);">
            附件：{{ selected.attachments.map(a => a.name || a.filename).join('、') }}
          </div>
          <pre style="white-space:pre-wrap;word-break:break-word;margin-top:6px;font-family:inherit;">{{ selectedBody }}</pre>
        </div>
      </div>
      <div v-else>
        <div v-if="threads.length===0" style="color:var(--color-text-secondary);font-size:12px;">暂无邮件</div>
        <div v-for="t in threads" :key="t.key" style="border:1px solid var(--color-border);border-radius:6px;margin-bottom:6px;overflow:hidden;">
          <!-- 会话头 -->
          <div @click="toggleThread(t.key)" style="padding:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:6px;">
            <div style="min-width:0;">
              <div style="font-size:12px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {{ t.subject || '（无主题）' }}
                <span v-if="t.count>1" style="color:var(--color-text-secondary);font-weight:normal;"> ({{ t.count }})</span>
              </div>
              <div style="font-size:11px;color:var(--color-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {{ t.contact }} · {{ (t.latest.snippet || t.latest.body || '').slice(0, 60) }}
              </div>
            </div>
            <span style="font-size:11px;color:var(--color-text-secondary);flex-shrink:0;">{{ isThreadExpanded(t.key) ? '▾' : '▸' }}</span>
          </div>
          <!-- 会话内邮件列表 -->
          <div v-if="isThreadExpanded(t.key)">
            <div v-for="m in t.messages" :key="m.id" @click.stop="openMessage(m)"
                 style="padding:5px 6px 5px 16px;border-top:1px dashed var(--color-border);cursor:pointer;">
              <div style="font-size:11px;color:var(--color-text-secondary);">
                {{ m.sender || m.from || '未知' }}
                <span v-if="t.count>1" style="float:right;">{{ m.created_at || '' }}</span>
              </div>
              <div style="font-size:11px;">{{ (m.snippet || m.body || '').slice(0, 80) }}</div>
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
          <button class="jarvis-btn" @click="resolvePending(p,'approve')">批准</button>
          <button class="jarvis-btn" @click="resolvePending(p,'reject')">拒绝</button>
          <button class="jarvis-btn" @click="resolvePending(p,'delete')">删除</button>
        </div>
      </div>
    </div>
  </div>
  `,
};
