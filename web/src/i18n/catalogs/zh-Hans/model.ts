import type { Translation } from "../../../../../src/i18n/catalog.js";
import type { model as en } from "../en/model.js";

export const model = {
  error: {
    turn_in_flight: "{{agent}} 正在回复中。等回复结束再试，什么都没改。",
    model_changed: "页面加载后模型已经变了。页面已刷新，看一下再试。",
    unknown_model: "{{agent}} 不认识这个模型名。请用列表里的别名或完整的模型 id。",
    gateway_required: "这个模型需要 LiteLLM 网关。先用 tomo config 设置一个。",
    gateway_unroutable: "配置的 ChatGPT 订阅网关只转发 chatgpt/* 模型。",
    owner_dm_only: "只有你自己的对话能在浏览器里切换。",
    owner_setup_required: "还没有配置主人。",
    epoch_changed: "页面加载后 {{agent}} 重启过。页面已刷新，看一下再试。",
    persist_failed: "写不进 config.json，模型没有改。",
    session_not_found: "这个对话已经不在了。",
    invalid_model_change: "模型名太长或为空。",
    other: "没能确认切换结果。刷新后先检查模型再试。",
  },
  confirm: {
    title: "切换到 {{to}}？",
    body: "这个对话会从 {{from}} 换到 {{to}}。从下一条消息起使用新模型，聊天记录保留。",
  },
  effort: {
    session: "{{level}}，为这个 session 单独设置（sessionEffortOverrides）。", global: "{{level}}，config.json 里的默认值。",
    sdkDefault: "未设置，使用模型自己的默认值。", notSupported: "不发送，这个模型不支持 effort 设置。",
  },
  current: "模型 · {{title}}", overridden: "为这个 session 单独选的。不选的话会用默认的 {{model}}。",
  default: "config.json 里的默认值。",
  effortTitle: "这是 tomo 请求的级别。如果模型不支持，实际可能更低。", effortLine: "请求的 effort：{{effort}}",
  busy: "{{agent}} 正在回复。回复结束后才能切换。",
  readOnly: "群在这里是只读的。要改群的模型，在那个群里发送 /model。",
  offline: "连接后才能切换。",
  switched: "已从 {{from}} 切换到 {{to}}，下一条消息开始生效。", unchanged: "已经是 {{model}}，没有变化。",
  from: "从", to: "到", switching: "切换中…", switch: "切换模型", options: "模型", active: "当前",
  other: "其他模型", otherPlaceholder: "模型 id，比如 claude-opus-4-8", switchOther: "切换…",
  gateway: {
    chatgptOnly: "LiteLLM 网关只转发 chatgpt/* 模型，比如 {{example}}。",
    litellm: "也可以用 LiteLLM 的 provider/model 名称，比如 {{example}}。",
    none: "可以填任何 Claude 模型 id，保存前会先检查。",
  },
} satisfies Translation<typeof en>;
