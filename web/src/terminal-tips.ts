import { t } from "./i18n.js";
import en from "./locales/en-dynamic.js";
import ru from "./locales/ru-dynamic.js";
import tw from "./locales/zh-TW-dynamic.js";

export const DEFAULT_TERMINAL_TIP = "可直接粘贴图片，路径可点击预览";

const defaultTipLabels = new Set([DEFAULT_TERMINAL_TIP, en[DEFAULT_TERMINAL_TIP], ru[DEFAULT_TERMINAL_TIP], tw[DEFAULT_TERMINAL_TIP]]);

export function terminalTipText(source: string): string {
  return source === DEFAULT_TERMINAL_TIP ? t(source) : source;
}

export function terminalTipSource(label: string): string {
  return defaultTipLabels.has(label) ? DEFAULT_TERMINAL_TIP : label;
}
