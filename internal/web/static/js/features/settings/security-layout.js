import { setText, t } from "../../i18n.js";
import { mountSettingsFold, settingsHelpText } from "./mobile-layout.js";
export function initSecurityLayout(section, signal, addHelp) {
    const groups = [...section.querySelectorAll(":scope > [data-settings-topic]")];
    const peers = [];
    for (const [index, group] of groups.entries()) {
        const body = group.querySelector(":scope > .settings-block");
        mountSettingsFold(group, body, group, () => t(group.querySelector("h3").dataset.i18n), signal, {
            icon: group.dataset.settingsTopicIcon, heading: true, open: index === 0, peers,
        });
    }
    for (const disclosure of section.querySelectorAll("[data-security-disclosure]")) {
        const body = disclosure.querySelector(":scope > .security-disclosure-body");
        const fold = mountSettingsFold(disclosure, body, disclosure, () => t(disclosure.dataset.securityDisclosure), signal);
        if (disclosure.dataset.securityDisclosureHelp)
            fold.row.dataset.securityHelp = disclosure.dataset.securityDisclosureHelp;
    }
    for (const host of section.querySelectorAll("[data-security-help]")) {
        addHelp(host, () => host.firstElementChild?.textContent?.trim() || t("了解更多"), () => host.dataset.securityHelp.split(" ").flatMap(id => settingsHelpText(document.getElementById(id))));
    }
    const list = section.querySelector("#user-list");
    const tunnel = section.querySelector("#set-tunnel-on");
    const limit = section.querySelector("#set-upload");
    const [userSummary, tunnelSummary, uploadSummary] = peers.map(fold => fold.summary);
    const refresh = () => {
        const count = list.querySelectorAll(".user-row:not([aria-hidden])").length;
        setText(userSummary, "用户数 · {p0}", { p0: String(count) });
        setText(tunnelSummary, tunnel.checked ? "隧道已开启" : "隧道已关闭");
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
