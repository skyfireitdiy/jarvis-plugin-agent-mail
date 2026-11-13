// Agent Mail 插件 - 管理设置 Tab。
// 约定：纯浏览器 ES module，用 window.Vue 渲染，导出 default 组件，不 import 'vue'。
// 功能：授权状态查看/登录/登出、自动处理规则 CRUD、全局设置（轮询开关/间隔/白名单）。

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
  name: "AgentMailAdminTab",
  props: {
    workingDir: { type: String, default: "" },
  },
  data() {
    return {
      tab: "auth", // auth / rules / settings
      loading: false,
      error: "",
      // 授权
      authInfo: "",
      // 规则
      rules: [],
      editing: null,
      newRule: this.emptyRule(),
      // 设置
      settings: null,
    };
  },
  methods: {
    emptyRule() {
      return {
        name: "",
        enabled: true,
        trigger_type: "sender_contains",
        trigger_value: "",
        mode: "analyze",
        prompt_template:
          "请分析这封邮件（主题：{subject}，发件人：{sender}），正文如下：\n{body}",
        auto_reply: false,
        reply_scope: "sender",
        whitelist: [],
      };
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
    async switchTab(tab) {
      this.tab = tab;
      if (tab === "auth") await this.loadAuth();
      else if (tab === "rules") await this.loadRules();
      else if (tab === "settings") await this.loadSettings();
    },
    async loadAuth() {
      await this.guard(async () => {
        const payload = await callFunction("auth_status", {});
        this.authInfo = this.formatAuth(payload.data || payload);
      });
    },
    async doLogin() {
      await this.guard(async () => {
        const payload = await callFunction("auth_login", {});
        this.authInfo = this.formatAuth(payload.data || payload);
        this.toast("登录流程已发起（若需交互请用终端 agently-cli auth login）");
      });
    },
    async doLogout() {
      await this.guard(async () => {
        await callFunction("auth_logout", {});
        this.authInfo = "已登出";
        this.toast("已登出");
      });
    },
    formatAuth(data) {
      // 兼容两层嵌套：api.py 返回 {success, data:{ok, data:{logged_in,...}}}
      const inner = (data && data.data && typeof data.data === "object") ? data.data : data;
      if (!inner) return "无状态信息";
      const loggedIn = inner.logged_in === true;
      const lines = [];
      if (inner.logged_in !== undefined) {
        lines.push((loggedIn ? "✅ 已登录" : "⚠️ 未登录"));
      }
      if (inner.status) lines.push("状态: " + inner.status);
      if (inner.message) lines.push("说明: " + inner.message);
      if (inner.workspace) lines.push("工作区: " + inner.workspace);
      if (inner.user) lines.push("账号: " + inner.user);
      if (inner.email) lines.push("邮箱: " + inner.email);
      if (inner.account) lines.push("账号: " + inner.account);
      return lines.length ? lines.join("\n") : JSON.stringify(inner, null, 2);
    },
    async loadRules() {
      await this.guard(async () => {
        const payload = await callFunction("list_rules", {});
        this.rules = payload.data || [];
      });
    },
    async saveRule() {
      const r = this.editing || this.newRule;
      if (!r.name || !r.prompt_template) {
        this.error = "规则名称与提示词模板为必填";
        return;
      }
      await this.guard(async () => {
        if (this.editing) {
          await callFunction("update_rule", {
            rule_id: this.editing.id,
            rule: r,
          });
          this.toast("规则已更新");
        } else {
          await callFunction("create_rule", { rule: r });
          this.toast("规则已创建");
        }
        this.editing = null;
        this.newRule = this.emptyRule();
        await this.loadRules();
      });
    },
    async editRule(rule) {
      this.editing = JSON.parse(JSON.stringify(rule));
      this.newRule = this.emptyRule();
    },
    async cancelEdit() {
      this.editing = null;
      this.newRule = this.emptyRule();
    },
    async removeRule(rule) {
      const ok = window.__jarvisConfirm
        ? await window.__jarvisConfirm(`确认删除规则「${rule.name}」？`, {
            defaultConfirm: false,
          })
        : confirm(`确认删除规则「${rule.name}」？`);
      if (!ok) return;
      await this.guard(async () => {
        await callFunction("delete_rule", { rule_id: rule.id });
        this.toast("规则已删除");
        await this.loadRules();
      });
    },
    async loadSettings() {
      await this.guard(async () => {
        const payload = await callFunction("get_settings", {});
        this.settings = payload.data || {};
      });
    },
    async saveSettings() {
      await this.guard(async () => {
        const payload = await callFunction("update_settings", {
          settings: this.settings,
        });
        this.settings = payload.data || this.settings;
        this.toast("设置已保存");
      });
    },
  },
  mounted() {
    this.loadAuth();
  },
  template: `
  <div class="agent-mail-admin">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong>⚙️ Agent Mail 管理</strong>
    </div>
    <div style="margin-bottom:8px;display:flex;gap:6px;">
      <button class="jarvis-btn" :class="tab==='auth'?'jarvis-btn-primary':''" @click="switchTab('auth')">授权</button>
      <button class="jarvis-btn" :class="tab==='rules'?'jarvis-btn-primary':''" @click="switchTab('rules')">规则</button>
      <button class="jarvis-btn" :class="tab==='settings'?'jarvis-btn-primary':''" @click="switchTab('settings')">设置</button>
    </div>
    <div v-if="error" class="jarvis-alert" style="color:#d33;font-size:12px;margin-bottom:8px;">{{ error }}</div>
    <div v-if="loading" style="color:#888;font-size:12px;">加载中…</div>

    <!-- 授权 -->
    <div v-if="tab==='auth'">
      <div style="margin-bottom:8px;display:flex;gap:6px;">
        <button class="jarvis-btn" @click="loadAuth" :disabled="loading">刷新状态</button>
        <button class="jarvis-btn" @click="doLogin" :disabled="loading">登录</button>
        <button class="jarvis-btn" @click="doLogout" :disabled="loading">登出</button>
      </div>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#f5f5f5;border-radius:6px;padding:8px;font-size:11px;max-height:300px;overflow:auto;">{{ authInfo }}</pre>
      <div style="font-size:11px;color:#888;margin-top:6px;">
        提示：需先安装 agently-cli（npm install -g @tencent-qqmail/agently-cli）并登录。
        若页面内登录无法完成交互，请在终端执行 agently-cli auth login。
      </div>
    </div>

    <!-- 规则 -->
    <div v-if="tab==='rules'">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">自动处理规则（触发条件 + 提示词模板 + 自动回复开关）</div>
      <div v-for="r in rules" :key="r.id" style="border:1px solid #eee;border-radius:6px;padding:6px;margin-bottom:6px;font-size:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>{{ r.name }}</strong>
          <span>
            <span style="color:#888;">[{{ r.trigger_type }}{{ r.trigger_value ? ':' + r.trigger_value : '' }}]</span>
            <span style="color:#666;"> {{ r.mode }}</span>
            <span v-if="r.auto_reply" style="color:#080;"> 自动回复开</span>
            <span v-else style="color:#888;"> 自动回复关</span>
          </span>
        </div>
        <div style="color:#666;margin-top:4px;">{{ r.prompt_template.slice(0, 80) }}{{ r.prompt_template.length > 80 ? '…' : '' }}</div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="jarvis-btn" @click="editRule(r)">编辑</button>
          <button class="jarvis-btn" @click="removeRule(r)">删除</button>
        </div>
      </div>

      <div style="border:1px solid #ddd;border-radius:6px;padding:8px;margin-top:8px;">
        <div style="font-size:12px;font-weight:bold;margin-bottom:6px;">{{ editing ? '编辑规则' : '新建规则' }}</div>
        <input class="jarvis-input" v-model="(editing||newRule).name" placeholder="规则名称（必填）" style="width:100%;margin-bottom:6px;" />
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <select class="jarvis-input" v-model="(editing||newRule).trigger_type" style="flex:1;">
            <option value="sender_contains">发件人包含</option>
            <option value="keyword">关键词</option>
            <option value="all">全部邮件</option>
          </select>
          <input class="jarvis-input" v-model="(editing||newRule).trigger_value" placeholder="触发值（全部邮件可留空）" style="flex:2;" />
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <select class="jarvis-input" v-model="(editing||newRule).mode" style="flex:1;">
            <option value="analyze">只读分析</option>
            <option value="auto_reply">受控自动回复</option>
            <option value="manual_confirm">人工确认</option>
          </select>
          <select class="jarvis-input" v-model="(editing||newRule).reply_scope" style="flex:1;">
            <option value="sender">仅回原发件人</option>
            <option value="whitelist">白名单</option>
          </select>
        </div>
        <textarea class="jarvis-input" v-model="(editing||newRule).prompt_template" placeholder="提示词模板（支持 {subject}{sender}{body}{message_id}{attachments}）" rows="4" style="width:100%;margin-bottom:6px;"></textarea>
        <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;">
            <input type="checkbox" v-model="(editing||newRule).auto_reply" /> 启用自动回复（默认关闭）
          </label>
          <input class="jarvis-input" v-model="(editing||newRule).whitelist" placeholder="白名单（逗号分隔，如 @qq.com, boss@x.com）" style="flex:1;" />
        </div>
        <div style="display:flex;gap:6px;">
          <button class="jarvis-btn jarvis-btn-primary" @click="saveRule" :disabled="loading">{{ editing ? '保存修改' : '创建规则' }}</button>
          <button v-if="editing" class="jarvis-btn" @click="cancelEdit">取消</button>
        </div>
      </div>
    </div>

    <!-- 设置 -->
    <div v-if="tab==='settings' && settings">
      <div style="border:1px solid #ddd;border-radius:6px;padding:8px;font-size:12px;margin-bottom:8px;">
        <div style="font-weight:bold;margin-bottom:6px;">📧 邮箱信息</div>
        <div style="margin-bottom:6px;">
          <label>本机邮箱地址（如 xxx@agent.qq.com）：</label>
          <input class="jarvis-input" v-model="settings.mailbox" placeholder="xxx@agent.qq.com" style="width:100%;" />
        </div>
        <div style="margin-bottom:6px;">
          <label>邮箱域名（如 agent.qq.com，用于识别本机发件）：</label>
          <input class="jarvis-input" v-model="settings.mailbox_domain" placeholder="agent.qq.com" style="width:100%;" />
        </div>
        <button class="jarvis-btn" @click="saveSettings" :disabled="loading">保存邮箱信息</button>
      </div>
      <div style="border:1px solid #ddd;border-radius:6px;padding:8px;font-size:12px;">
        <div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          <label style="display:flex;align-items:center;gap:4px;">
            <input type="checkbox" v-model="settings.poll_enabled" /> 启用后台轮询
          </label>
        </div>
        <div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          <label>轮询间隔（秒）：</label>
          <input class="jarvis-input" type="number" v-model.number="settings.poll_interval_seconds" style="width:120px;" />
        </div>
        <div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          <label>每次最多处理：</label>
          <input class="jarvis-input" type="number" v-model.number="settings.max_new_messages" style="width:80px;" />
        </div>
        <div style="margin-bottom:6px;">
          <label>全局自动回复白名单（逗号分隔，如 @qq.com）：</label>
          <input class="jarvis-input" v-model="settings.auto_reply_whitelist" style="width:100%;" />
        </div>
        <button class="jarvis-btn jarvis-btn-primary" @click="saveSettings" :disabled="loading">保存设置</button>
      </div>
      <div style="font-size:11px;color:#888;margin-top:6px;">
        安全提示：自动回复默认关闭；回复范围默认仅回原发件人；白名单可限制自动回复对象。
      </div>
    </div>
  </div>
  `,
};
