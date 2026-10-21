/** 极简 i18n（NFR-07） */

import { zh } from "./zh";
import { en } from "./en";

export type Lang = "zh" | "en";
export type LangPref = "auto" | Lang;

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function createTranslator(lang: Lang): Translate {
	return (key: string, vars?: Record<string, string | number>): string => {
		let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
		if (vars) {
			for (const [k, v] of Object.entries(vars)) {
				s = s.split(`{${k}}`).join(String(v));
			}
		}
		return s;
	};
}

/** 把用户偏好解析为实际语言；auto 时按系统语言判断 */
export function resolveLang(pref: LangPref, systemLocale = ""): Lang {
	if (pref === "zh" || pref === "en") return pref;
	const l = (systemLocale || (typeof navigator !== "undefined" ? navigator.language : "") || "").toLowerCase();
	return l.startsWith("zh") ? "zh" : "en";
}
