import { setText, t } from "../../i18n.js";
import type { IconSlot } from "../../icons.js";
import { mountSettingsFold, settingsHelpText, type AddSettingsHelp } from "./mobile-layout.js";

export function initSecurityLayout(section: HTMLElement, signal: AbortSignal, addHelp: AddSettingsHelp) {
  const groups = [...section.querySelectorAll<HTMLElement>(":scope > [data-settings-topic]")];
  const peers: ReturnType<typeof mountSettingsFold>[] = [];
  for (const [index, group] of groups.entries()) {
    const body = group.querySelector<HTMLElement>(":scope > .settings-block")!;
    mountSettingsFold(group, body, group, () => t(group.querySelector("h3")!.dataset.i18n!), signal, {
      icon: group.dataset.settingsTopicIcon as IconSlot, heading: true, open: index === 0, peers,
    });
  }
  for (const disclosure of section.querySelectorAll<HTMLElement>("[data-security-disclosure]")) {
    const body = disclosure.querySelector<HTMLElement>(":scope > .security-disclosure-body")!;
    const fold = mountSettingsFold(disclosure, body, disclosure, () => t(disclosure.dataset.securityDisclosure!), signal);
    if (disclosure.dataset.securityDisclosureHelp) fold.row.dataset.securityHelp = disclosure.dataset.securityDisclosureHelp;
  }
  for (const host of section.querySelectorAll<HTMLElement>("[data-security-help]")) {
    addHelp(host, () => host.firstElementChild?.textContent?.trim() || t("了解更多"), () =>
      host.dataset.securityHelp!.split(" ").flatMap(id => settingsHelpText(document.getElementById(id))));
  }
  const list = section.querySelector("#user-list")!;
  const deviceLink = section.querySelector<HTMLInputElement>("#set-device-link-on")!;
  const limit = section.querySelector<HTMLInputElement>("#set-upload")!;
  const [userSummary, deviceSummary, uploadSummary] = peers.map(fold => fold.summary);
  const refresh = () => {
    const count = list.querySelectorAll(".user-row:not([aria-hidden])").length;
    setText(userSummary, "用户数 · {p0}", { p0: String(count) });
    setText(deviceSummary, deviceLink.checked ? "设备连接已启用" : "设备连接已停用");
    setText(uploadSummary, limit.value ? "上传上限 · {p0} MB" : "上传与监听", { p0: limit.value });
  };
  refresh();
  const users = new MutationObserver(refresh);
  users.observe(list, { childList: true });
  section.addEventListener("input", refresh, { signal });
  section.addEventListener("change", refresh, { signal });
  signal.addEventListener("abort", () => users.disconnect(), { once: true });
  return refresh;
}
