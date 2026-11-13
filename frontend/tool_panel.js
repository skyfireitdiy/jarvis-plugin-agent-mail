// Agent Mail 插件 - 工具面板（手动邮件操作）。
// 约定：纯浏览器 ES module，用 window.Vue 渲染，导出 default 组件，不 import 'vue'。
// 功能：手动发送新邮件、回复、转发、移入回收站、删除邮件。
// 写操作（send/reply/forward/trash/delete）需要 confirmation-token 或用户授权（confirmed）。

const PLUGIN = "agent-mail";

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
  name: "AgentMailToolPanel",
  props: {
    workingDir: { type: String, default: "" },
  },
  data() {
    return {
      tab: "send", // send / reply / forward / manage
      loading: false,
      error: "",
      result: "",
      // 发送
      to: "",
      subject: "",
      body: "",
      // 回复/转发/删除
      messageId: "",
      // 授权确认
      confirmed: false,
      // 管理（列表消息供选择）
      messages: [],
    };
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
      this.result = "";
      try {
        await fn();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },
    async doSend() {
      if (!this.to.trim()) {
        this.error = "请填写收件人";
        return;
      }
      await this.guard(async () => {
        const payload = await callFunction("send_message", {
          to: this.to.trim(),
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
    async loadMessages() {
      await this.guard(async () => {
        const payload = await callFunction("list_messages", {
          page: 1,
          page_size: 20,
        });
        const data = payload.data || {};
        this.messages = data.messages || data.items || data.list || [];
      });
    },
  },
  mounted() {
    this.loadMessages();
  },
  template: `
  <div class="agent-mail-tool">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong>✉️ Agent Mail 工具</strong>
    </div>
    <div style="margin-bottom:8px;display:flex;gap:6px;">
      <button class="jarvis-btn" :class="tab==='send'?'jarvis-btn-primary':''" @click="tab='send'">发送</button>
      <button class="jarvis-btn" :class="tab==='reply'?'jarvis-btn-primary':''" @click="tab='reply'">回复</button>
      <button class="jarvis-btn" :class="tab==='forward'?'jarvis-btn-primary':''" @click="tab='forward'">转发</button>
      <button class="jarvis-btn" :class="tab==='manage'?'jarvis-btn-primary':''" @click="tab='manage'">管理</button>
    </div>
    <div v-if="error" class="jarvis-alert" style="color:#d33;font-size:12px;margin-bottom:8px;">{{ error }}</div>
    <div v-if="loading" style="color:#888;font-size:12px;">执行中…</div>

    <div style="margin-bottom:8px;font-size:12px;color:#666;">
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" v-model="confirmed" /> 我已确认此操作（免除 confirmation-token）
      </label>
    </div>

    <!-- 发送 -->
    <div v-if="tab==='send'">
      <input class="jarvis-input" v-model="to" placeholder="收件人（必填）" style="width:100%;margin-bottom:6px;" />
      <input class="jarvis-input" v-model="subject" placeholder="主题" style="width:100%;margin-bottom:6px;" />
      <textarea class="jarvis-input" v-model="body" placeholder="正文" rows="5" style="width:100%;margin-bottom:6px;"></textarea>
      <button class="jarvis-btn jarvis-btn-primary" @click="doSend" :disabled="loading">发送邮件</button>
    </div>

    <!-- 回复 -->
    <div v-if="tab==='reply'">
      <input class="jarvis-input" v-model="messageId" placeholder="message_id（必填）" style="width:100%;margin-bottom:6px;" />
      <textarea class="jarvis-input" v-model="body" placeholder="回复正文（必填）" rows="5" style="width:100%;margin-bottom:6px;"></textarea>
      <button class="jarvis-btn jarvis-btn-primary" @click="doReply" :disabled="loading">发送回复</button>
    </div>

    <!-- 转发 -->
    <div v-if="tab==='forward'">
      <input class="jarvis-input" v-model="messageId" placeholder="message_id（必填）" style="width:100%;margin-bottom:6px;" />
      <input class="jarvis-input" v-model="to" placeholder="收件人（必填）" style="width:100%;margin-bottom:6px;" />
      <textarea class="jarvis-input" v-model="body" placeholder="附加说明（可选）" rows="3" style="width:100%;margin-bottom:6px;"></textarea>
      <button class="jarvis-btn jarvis-btn-primary" @click="doForward" :disabled="loading">转发邮件</button>
    </div>

    <!-- 管理 -->
    <div v-if="tab==='manage'">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">最近邮件（点击填入 message_id）：</div>
      <div v-for="m in messages" :key="m.id" @click="messageId=m.id"
           style="border:1px solid #eee;border-radius:6px;padding:6px;margin-bottom:6px;cursor:pointer;font-size:12px;">
        <div><strong>{{ m.subject || '（无主题）' }}</strong></div>
        <div style="color:#666;">{{ m.sender || m.from || '未知' }} · {{ m.id }}</div>
      </div>
      <div style="margin-top:8px;">
        <input class="jarvis-input" v-model="messageId" placeholder="message_id" style="width:100%;margin-bottom:6px;" />
        <div style="display:flex;gap:6px;">
          <button class="jarvis-btn" @click="doTrash" :disabled="loading">移入回收站</button>
          <button class="jarvis-btn" @click="doDelete" :disabled="loading">永久删除</button>
        </div>
      </div>
    </div>

    <pre v-if="result" style="white-space:pre-wrap;word-break:break-word;background:#f5f5f5;border-radius:6px;padding:8px;margin-top:8px;font-size:11px;max-height:200px;overflow:auto;">{{ result }}</pre>
  </div>
  `,
};
