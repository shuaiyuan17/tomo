import { LOCALES, localeName, useLocaleChoice, useTranslation, type Locale } from "./i18n/index.js";
import { cn } from "@/lib/utils";
import { card, meta } from "./study-ui.js";

/**
 * The UI language for this browser, in the Study's Config tab (the page's
 * settings): Default follows config `locale`, else the browser's language;
 * a pick is kept in this browser only.
 */
export function LanguageSetting() {
  const { t } = useTranslation();
  const [choice, setChoice] = useLocaleChoice();
  return <section aria-labelledby="language-heading" className={cn(card, "mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4")}>
    <div className="min-w-0">
      <label id="language-heading" htmlFor="language-picker" className="text-[14px] font-medium">{t("language.heading")}</label>
      <p className={cn(meta, "mt-1 mb-0")}>{t("language.note")}</p>
    </div>
    <select id="language-picker" value={choice ?? "default"} onChange={(event) => setChoice(event.target.value === "default" ? null : event.target.value as Locale)}
      className="h-9 rounded-lg border bg-card px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring max-phone:h-10 max-phone:text-base">
      <option value="default">{t("language.default")}</option>
      {LOCALES.map((locale) => <option key={locale} value={locale}>{localeName(locale)}</option>)}
    </select>
  </section>;
}
