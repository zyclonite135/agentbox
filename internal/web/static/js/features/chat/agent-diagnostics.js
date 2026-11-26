import { setText } from "../../i18n.js";
import { svgIcon } from "../../icons.js";
const label = {
    failed: "处理请求时发生错误。",
    warning: "代理报告了一条警告。",
    retry: "代理正在重试请求。",
    missingEnv: "未设置环境变量 {name}。",
    invalidKey: "服务商拒绝了 API 密钥。请检查账号设置。",
    expired: "授权已过期。请重新连接账号。",
    unauthorized: "无法向服务商验证身份。",
    forbidden: "服务商拒绝访问此请求。",
    unavailableModel: "此账号无法使用模型 {model}。",
    unnamedModel: "此账号无法使用所请求的模型。",
    proxyModel: "代理服务没有可使用模型 {model} 的账号。",
    proxyUnnamed: "代理服务没有可使用所请求模型的账号。",
    rate: "请求过多。请稍后重试。",
    quota: "服务商额度已用尽。",
    rejected: "服务商拒绝了请求（HTTP 429）。",
    retries429: "多次尝试后，服务商仍拒绝了请求（HTTP 429）。",
    overload: "服务商暂时过载。请稍后重试。",
    timeout: "服务商未能及时响应。",
    disconnected: "连接已中断。代理正在重试请求。",
    connect: "无法连接到服务商。",
    context: "此对话的文本超出了模型限制。请缩短请求或开启新对话。",
    fileSize: "文件太大。请附加较小的文件。",
    fileFormat: "服务商不支持此文件格式。",
    metadata: "Codex 找不到模型 {model} 的元数据，正在使用备用元数据。",
    resume: "对话以模型 {previous_model} 开始，现以 {current_model} 继续。更换模型可能影响结果。",
};
const byCode = new Map([
    ...["invalid_api_key", "incorrect_api_key"].map(code => [code, label.invalidKey]),
    ...["token_expired", "authentication_expired", "expired_token"].map(code => [code, label.expired]),
    ...["authentication_error", "unauthorized"].map(code => [code, label.unauthorized]),
    ...["permission_error", "permission_denied", "forbidden"].map(code => [code, label.forbidden]),
    ...["rate_limit_error", "rate_limit_exceeded", "rateLimitExceeded", "slow_down"].map(code => [code, label.rate]),
    ...["insufficient_quota", "credit_balance_exhausted", "usage_limit_exceeded", "usageLimitExceeded",
        "apiKeySpendLimitExceeded", "projectSpendLimitExceeded", "organizationSpendLimitExceeded",
        "project_spend_limit_exceeded", "organization_spend_limit_exceeded", "organization_usage_limit_exceeded",
        "contract_spend_limit_reached"].map(code => [code, label.quota]),
    ...["overloaded_error", "server_is_overloaded", "serverOverloaded"].map(code => [code, label.overload]),
    ...["timeout_error", "request_timeout"].map(code => [code, label.timeout]),
    ...["context_length_exceeded", "contextWindowExceeded"].map(code => [code, label.context]),
    ...["file_too_large", "image_too_large"].map(code => [code, label.fileSize]),
    ...["unsupported_file_format", "unsupported_image_format", "invalid_image_format"].map(code => [code, label.fileFormat]),
]);
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const string = (value) => typeof value === "string" ? value.trim() : "";
const identifier = (value) => {
    const text = string(value);
    return /^[a-z0-9][\w.-]{0,159}$/i.test(text) ? text : "";
};
const diagnosticCode = (value) => typeof value === "number" && Number.isSafeInteger(value) ? String(value) : identifier(value);
const modelID = (value) => {
    const text = string(value);
    return /^[a-z0-9][\w./:-]{0,127}(?:\[1m\])?$/i.test(text) ? text : "";
};
const httpStatus = (value) => {
    const text = typeof value === "number" ? String(value) : string(value);
    return /^[45]\d{2}$/.test(text) ? text : "";
};
function providerPayload(message) {
    // Provider JSON may arrive directly or embedded in a known CLI status line.
    if (message.length > 32768 || !/^(?:\{|API Error:|unexpected status\b)/i.test(message))
        return;
    const start = message.indexOf("{"), end = message.lastIndexOf("}");
    if (start < 0 || end <= start)
        return;
    try {
        return record(JSON.parse(message.slice(start, end + 1)));
    }
    catch {
        return undefined;
    }
}
const fallback = (tone) => tone === "retry" ? label.retry : tone === "warning" ? label.warning : label.failed;
function describeMessage(value, raw, tone) {
    const event = record(value);
    const error = record(event?.error) || event;
    const text = raw.trim();
    const extraValue = error?.additionalDetails ?? event?.additionalDetails;
    const extra = typeof extraValue === "string" ? extraValue : "";
    const body = providerPayload(text) || providerPayload(extra.trim());
    const provider = record(body?.error) || body;
    const info = error?.codexErrorInfo ?? event?.codexErrorInfo;
    const variant = Object.keys(record(info) || {})[0] || "";
    const codexCode = identifier(info) || identifier(variant);
    const providerCode = diagnosticCode(provider?.code) || diagnosticCode(error?.code) || diagnosticCode(event?.code);
    const providerType = identifier(provider?.type) || (error !== event ? identifier(error?.type) : "");
    const message = string(provider?.message) || text.replace(/^API Error:\s*[45]\d{2}\s*[-:]?\s*/i, "");
    const status = httpStatus(record(record(info)?.[variant])?.httpStatusCode)
        || httpStatus(error?.httpStatusCode ?? error?.status_code ?? event?.httpStatusCode ?? event?.status_code ?? body?.status)
        || (/^(?:exceeded retry limit,\s*last status:|unexpected status|API Error:)\s*([45]\d{2})\b/i.exec(text)?.[1] || "");
    const requestID = identifier(provider?.request_id ?? body?.request_id ?? error?.request_id ?? error?.requestId ?? event?.request_id ?? event?.requestId)
        || identifier(/(?:^|[\s,])request[_ -]id\s*:\s*[\x60'"]?([\w-](?:[\w.-]*[\w-])?)/i.exec(raw)?.[1]);
    const code = providerCode || codexCode || providerType || (event?.type === "result" ? identifier(event.subtype) : "");
    const detail = { code, status, requestID, extra };
    const summary = (source, params) => ({ ...detail, source, params });
    if (tone === "warning") {
        const metadata = /^Model metadata for [\x60'"]([^'\x60"]+)[\x60'"] not found\./i.exec(message);
        if (metadata)
            return summary(label.metadata, { model: metadata[1] });
        const resume = /^This session was recorded with model [\x60'"]([^'\x60"]+)[\x60'"] but is resuming with [\x60'"]([^'\x60"]+)[\x60'"]/i.exec(message);
        if (resume)
            return summary(label.resume, { previous_model: resume[1], current_model: resume[2] });
    }
    const model = modelID(provider?.model ?? error?.model ?? event?.model)
        || modelID(/^(?:No accounts with a plan supporting model|(?:The )?model)\s+[\x60'"]([^'\x60"]+)[\x60'"]/i.exec(message)?.[1]);
    if (tone === "retry") {
        const dropped = codexCode === "responseStreamDisconnected" || /^stream disconnected before completion\b/i.test(message);
        return summary(dropped ? label.disconnected : label.retry);
    }
    const missingModel = () => model ? summary(label.unavailableModel, { model }) : summary(label.unnamedModel);
    const missingProxyModel = () => model ? summary(label.proxyModel, { model }) : summary(label.proxyUnnamed);
    const byExplicitCode = (value) => {
        if (value === "no_plan_support_for_model")
            return missingProxyModel();
        if (["model_not_found", "modelNotFound", "unsupported_model"].includes(value))
            return missingModel();
        const source = byCode.get(value);
        return source ? summary(source) : undefined;
    };
    const named = byExplicitCode(providerCode) || byExplicitCode(codexCode);
    if (named)
        return named;
    if (/^No accounts with a plan supporting model\b/i.test(message))
        return missingProxyModel();
    if (/^(?:The )?model [\x60'"][^'\x60"]+[\x60'"] (?:does not exist|is not supported|is not available)/i.test(message))
        return missingModel();
    const env = /^Missing environment variable:\s*[\x60'"]?([A-Za-z_][A-Za-z0-9_]*)[\x60'"]?\.?$/i.exec(message);
    if (env)
        return summary(label.missingEnv, { name: env[1] });
    if (/^(?:Incorrect API key provided|Invalid (?:x-)?api[- ]key\b)/i.test(message))
        return summary(label.invalidKey);
    if (/^(?:(?:OAuth|access|authentication) token (?:has )?expired|(?:Your )?authentication (?:has )?expired)/i.test(message))
        return summary(label.expired);
    if (/^(?:Codex ran out of room in the model.s context window|context (?:window|length) exceeded|prompt is too long|maximum context length)/i.test(message))
        return summary(label.context);
    if (/^(?:rate limit exceeded|too many requests)\b/i.test(message))
        return summary(label.rate);
    if (/^(?:quota exceeded|you exceeded your current quota|insufficient quota|credit balance exhausted)\b/i.test(message))
        return summary(label.quota);
    if (/^(?:server overloaded|the server is overloaded|overloaded|model is temporarily overloaded)\b/i.test(message))
        return summary(label.overload);
    if (/^(?:file|image|attachment) (?:is )?too large\b/i.test(message))
        return summary(label.fileSize);
    if (/^(?:unsupported (?:file|image) (?:type|format)|(?:file|image) format (?:is )?not supported)\b/i.test(message))
        return summary(label.fileFormat);
    const typed = byCode.get(providerType);
    if (typed)
        return summary(typed);
    if (status === "429") {
        return summary(codexCode === "responseTooManyFailedAttempts" || /^exceeded retry limit\b/i.test(text) ? label.retries429 : label.rejected);
    }
    if (status === "401")
        return summary(label.unauthorized);
    if (status === "403")
        return summary(label.forbidden);
    if (status === "529")
        return summary(label.overload);
    if (status === "408" || status === "504" || /^(?:request (?:timed out|timeout)|(?:operation|connection) timed out|deadline exceeded)\b/i.test(message))
        return summary(label.timeout);
    if (["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"].includes(codexCode)
        || /^(?:connection refused|error sending request|failed to connect|stream disconnected before completion)\b/i.test(message)) {
        return summary(label.connect);
    }
    return summary(fallback(tone));
}
export function describeAgentDiagnostic(value, raw, tone) {
    const input = Array.isArray(raw) ? raw : [raw];
    const messages = [...new Set(input.filter((text) => typeof text === "string" && !!text.trim()))];
    const primary = describeMessage(value, messages[0] || "", tone);
    const original = messages.join("\n");
    const fallbackSource = fallback(tone);
    if (primary.source === fallbackSource) {
        for (const message of messages.slice(1)) {
            const candidate = describeMessage(value, message, tone);
            if (candidate.source !== fallbackSource)
                return {
                    ...candidate, raw: original,
                    code: candidate.code || primary.code, status: candidate.status || primary.status, requestID: candidate.requestID || primary.requestID,
                };
        }
    }
    return { ...primary, raw: original };
}
export function agentDiagnostic(value, raw, tone) {
    const diagnostic = describeAgentDiagnostic(value, raw, tone);
    const chip = document.createElement("div");
    chip.className = "chip has-icon agent-diagnostic " + (tone === "error" ? "err" : "warn");
    const body = document.createElement("div");
    body.className = "agent-diagnostic-body";
    const title = document.createElement("div");
    setText(title, diagnostic.source, diagnostic.params);
    body.append(title);
    if (diagnostic.raw || diagnostic.code || diagnostic.status || diagnostic.requestID || diagnostic.extra) {
        const details = document.createElement("details");
        const toggle = document.createElement("summary");
        setText(toggle, "代理诊断详情");
        details.append(toggle);
        const identifiers = document.createElement("dl");
        for (const [name, detail] of [
            ["代理错误代码", diagnostic.code], ["HTTP 状态", diagnostic.status], ["请求 ID", diagnostic.requestID],
        ]) {
            if (!detail)
                continue;
            const term = document.createElement("dt"), value = document.createElement("dd");
            setText(term, name);
            value.textContent = detail;
            identifiers.append(term, value);
        }
        if (identifiers.childElementCount)
            details.append(identifiers);
        for (const detail of new Set([diagnostic.raw, diagnostic.extra])) {
            if (!detail)
                continue;
            const original = document.createElement("pre");
            original.textContent = detail;
            details.append(original);
        }
        body.append(details);
    }
    chip.append(svgIcon(tone === "error" ? "chat.error" : "chat.warning", 14), body);
    return chip;
}
