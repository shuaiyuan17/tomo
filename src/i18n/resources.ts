import type { Locale } from "./locales.js";
import type { Translation } from "./catalog.js";
import { errors as enErrors } from "./catalogs/en/errors.js";
import { errors as zhErrors } from "./catalogs/zh-Hans/errors.js";
import { permissions as enPermissions } from "./catalogs/en/permissions.js";
import { permissions as zhPermissions } from "./catalogs/zh-Hans/permissions.js";
import { notices as enNotices } from "./catalogs/en/notices.js";
import { notices as zhNotices } from "./catalogs/zh-Hans/notices.js";
import { menu as enMenu } from "./catalogs/en/menu.js";
import { menu as zhMenu } from "./catalogs/zh-Hans/menu.js";
import { credentials as enCredentials } from "./catalogs/en/credentials.js";
import { credentials as zhCredentials } from "./catalogs/zh-Hans/credentials.js";
import { commands as enCommands } from "./catalogs/en/commands.js";
import { commands as zhCommands } from "./catalogs/zh-Hans/commands.js";
import { cost as enCost } from "./catalogs/en/cost.js";
import { cost as zhCost } from "./catalogs/zh-Hans/cost.js";
import { tasks as enTasks } from "./catalogs/en/tasks.js";
import { tasks as zhTasks } from "./catalogs/zh-Hans/tasks.js";
import { todo as enTodo } from "./catalogs/en/todo.js";
import { todo as zhTodo } from "./catalogs/zh-Hans/todo.js";
import { usage as enUsage } from "./catalogs/en/usage.js";
import { usage as zhUsage } from "./catalogs/zh-Hans/usage.js";
import { subsessions as enSubsessions } from "./catalogs/en/subsessions.js";
import { subsessions as zhSubsessions } from "./catalogs/zh-Hans/subsessions.js";

/**
 * Every daemon-side catalog, by locale and namespace (one namespace per
 * feature). English is the source and the type of every key; each other
 * locale must satisfy `Translation<typeof en>`, so a missing or extra key is
 * a compile error. tests/i18n-catalogs.test.ts adds what tsc cannot see:
 * matching placeholders, and no key left unused.
 *
 * Adding a namespace: `catalogs/en/<ns>.ts` (`export const <ns> = { ... }
 * as const`), `catalogs/zh-Hans/<ns>.ts` (the same name, `satisfies
 * Translation<typeof en>`), and one entry per locale below.
 */
const en = {
  errors: enErrors,
  permissions: enPermissions,
  notices: enNotices,
  menu: enMenu,
  credentials: enCredentials,
  commands: enCommands,
  cost: enCost,
  tasks: enTasks,
  todo: enTodo,
  usage: enUsage,
  subsessions: enSubsessions,
} as const;

export const resources = {
  en,
  "zh-Hans": {
    errors: zhErrors,
    permissions: zhPermissions,
    notices: zhNotices,
    menu: zhMenu,
    credentials: zhCredentials,
    commands: zhCommands,
    cost: zhCost,
    tasks: zhTasks,
    todo: zhTodo,
    usage: zhUsage,
    subsessions: zhSubsessions,
  },
} satisfies { en: typeof en } & Record<Exclude<Locale, "en">, Translation<typeof en>>;

export type ServerResources = typeof en;
export type ServerNamespace = keyof ServerResources;
export const NAMESPACES = Object.keys(en) as ServerNamespace[];
