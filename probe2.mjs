import pino from "pino";
import { LOG_REDACT_PATHS, redactLogRecord, scrubSecretValues } from "/tmp/tomo-security/dist/redact.js";
const out = [];
const log = pino({
  level: "debug",
  redact: { paths: LOG_REDACT_PATHS },
  formatters: { log: (r) => redactLogRecord(r) },
  serializers: { err: (e) => {
    const s = redactLogRecord(pino.stdSerializers.err(e));
    for (const f of ["message","stack","type"]) if (typeof s[f] === "string") s[f] = scrubSecretValues(s[f]);
    return s;
  } },
  hooks: { logMethod(args, method) {
    for (let i=0;i<args.length;i++) if (typeof args[i]==="string") args[i]=scrubSecretValues(args[i]);
    return method.apply(this, args);
  } },
}, { write: (c) => out.push(c) });

const TOKEN = "8123456:AAHnotarealbottokenvalue9xQzABCDEFG";
log.info({ config: { channels: { telegram: { token: TOKEN } } } }, "depth-4");
log.info({ mcpServers: { acme: { headers: { Authorization: "Bearer sk-ant-abcdefghijklmnop1234" } } } }, "depth-4 headers");
const axiosErr = new Error("Request failed");
axiosErr.config = { headers: { Authorization: "Bearer sk-ant-abcdefghijklmnop1234" } };
log.error({ err: axiosErr }, "axios-shaped");
const grammy = new Error(`Call to 'getUpdates' failed: https://api.telegram.org/bot${TOKEN}/getUpdates`);
log.error({ err: grammy }, "grammy-shaped");
log.info({ tool: "Read" }, `{"telegramToken":"${TOKEN}","apiKey":"sk-ant-abcdefghijklmnop1234"}`);
const shared = { name: "x" };
log.info({ a: shared, b: shared, when: new Date("2020-01-01"), s: new Set([1]) }, "dag");
const text = out.join("");
console.log(text);
console.log("LEAK:", text.includes(TOKEN) || text.includes("sk-ant-abcdefghijklmnop1234"));
