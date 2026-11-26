export const problemMessages = {
    "delegation_unavailable": ["委派工具暂时无法准备", "请关闭「委派」后重新发送，或联系管理员检查账号出口网桥配置。"],
    "chat_request_conflict": ["消息编号与已接收内容或状态不一致", "请查询原消息状态，核对后使用新的消息编号。"],
    "chat_request_gone": ["该消息已放弃或删除", "请核对历史和工作区结果；不会重新执行这个消息编号。"],
    "chat_request_not_found": ["尚未查到该消息的接收记录", "请保留待确认内容并重试查询，不要换编号重复发送。"],
    "chat_pending": ["有消息尚未结束或结果待核对", "请先查询消息状态、查看历史和文件，再明确核对结果。"],
    "chat_scope_changed": ["消息所属的实例或登录身份已变化", "请重新登录并核对原任务；不会自动重新发送。"],
    "chat_thread_changed": ["当前对话与消息所属对话不一致", "请返回原对话并核对输入后再发送。"],
    "chat_attachments_invalid": ["消息附件已失效或无法验证", "请移除失效附件或重新上传，核对后再发送。"],
    "project_upload_limits": [
        "项目上传超过限制",
        "请减少文件数量或体积；大小限制可由管理员调整。"
    ],
    "creation_conflict": [
        "创建信息与已接收记录不一致",
        "请继续原创建流程，或明确开始新的创建。"
    ],
    "creation_model_unavailable": [
        "所选模型已不适用于此账号",
        "请重新选择模型或使用账号默认模型。"
    ],
    "creation_gone": [
        "该创建已放弃或空间已删除",
        "请刷新空间列表；不会重新创建已删除空间。"
    ],
    "import_pending": [
        "导入仍在执行或结果待核对",
        "请先查询结果或查看已有目录，不要重复提交。"
    ],
    "import_failed": [
        "项目导入失败",
        "请检查上传内容、仓库地址或 Git 连接，在同一空间重试。"
    ],
    "import_target_exists": [
        "目标目录已存在",
        "请查看现有文件，或选择新的目录；不会覆盖原目录。"
    ],
    "invalid_request": [
        "请求格式错误",
        "请检查输入后重新提交。"
    ],
    "invalid_credentials": [
        "账号或密码错误",
        "请核对用户名和密码后重新登录。"
    ],
    "login_rate_limited": [
        "登录尝试过于频繁",
        "请稍后再登录；忘记密码请联系管理员。"
    ],
    "authentication_required": [
        "登录已过期",
        "请重新登录后继续。"
    ],
    "admin_required": [
        "需要管理员权限",
        "请联系实例管理员处理。"
    ],
    "session_not_found": [
        "工作空间不存在或不可访问",
        "请刷新空间列表并重新选择。"
    ],
    "account_access_denied": [
        "当前用户无权使用该账号",
        "请联系管理员调整账号使用范围。"
    ],
    "account_unavailable": [
        "空间绑定的账号不可用",
        "请联系管理员检查账号配置。"
    ],
    "account_credentials_unavailable": [
        "账号凭证无法准备",
        "请联系管理员检查凭证并在需要时重新授权账号。"
    ],
    "quota_exhausted": [
        "额度已用完",
        "请联系管理员充值后再继续。"
    ],
    "capacity_exhausted": [
        "运行空间数量已达上限",
        "请停止不用的空间，或联系管理员调整容量。"
    ],
    "storage_full": [
        "数据盘可用空间不足",
        "请联系管理员释放磁盘空间后重试。"
    ],
    "storage_permission_denied": [
        "数据目录权限不足",
        "请联系管理员检查数据目录及容器用户的读写权限。"
    ],
    "docker_unavailable": [
        "无法连接 Docker 服务",
        "请联系管理员检查 Docker 服务和访问权限。"
    ],
    "agent_image_missing": [
        "工作空间镜像不存在",
        "请联系管理员构建或安装配置中指定的 Agent 镜像。"
    ],
    "browser_image_required": [
        "当前镜像未安装浏览器",
        "请管理员构建并选择 agentbox-agent:browser 镜像，然后停止并重新启动工作空间。"
    ],
    "workspace_start_failed": [
        "工作空间启动失败",
        "请将操作编号交给管理员检查环境，修复后再启动。"
    ],
    "chat_busy": [
        "上一条消息仍在处理中",
        "请等待当前回合完成，或先中断当前回合。"
    ],
    "chat_parallel_limit": [
        "同时运行的对话已达上限",
        "这个工作空间同时运行的对话已达上限，请等其中一个完成或中断后再发送。"
    ],
    "question_closed": [
        "这个问题已经结束",
        "可能已在其他页面回答、超时后自动跳过，或者回合已经结束。"
    ],
    "chat_options_invalid": [
        "对话模型或推理设置不可用",
        "请调整模型和推理设置，必要时联系管理员检查 CLI 兼容性。"
    ],
    "chat_failed": [
        "对话执行失败",
        "请先查看对话历史和工作区结果，再决定是否重新发送。"
    ],
    "mcp_configuration_failed": [
        "MCP 配置尚未应用",
        "请在 MCP 设置中处理冲突或检测配置后重试。"
    ],
    "operation_timed_out": [
        "操作超时",
        "请先检查当前空间和任务状态，再决定是否重试。"
    ],
    "operation_cancelled": [
        "操作已取消",
        "请检查当前空间和任务状态后再继续。"
    ],
    "server_stopping": [
        "服务正在重启或停止",
        "请稍后重新连接并核对任务状态。"
    ],
    "server_restarted": [
        "服务重启，这一轮已中断",
        "已经执行的操作不会撤销；服务恢复后发消息即可接着做。"
    ],
    "server_upgraded": [
        "服务升级，这一轮已中断",
        "已经执行的操作不会撤销；服务恢复后发消息即可接着做。"
    ],
    "chat_quota_paused": [
        "5 小时额度达到暂停阈值，这一轮已暂停",
        "已经执行的操作不会撤销；额度重置后自动发「继续」接着做。可在「缓存保活」里调整暂停阈值。"
    ],
    "chat_quota_reserved": [
        "5 小时额度已达到暂停阈值",
        "剩余额度留给缓存保活。额度重置后再发，或以排队方式发送；也可在「缓存保活」里调高或关闭暂停阈值。"
    ],
    "chat_turn_timed_out": [
        "这一轮超过时长上限，已自动中断",
        "已经执行的操作不会撤销；发消息即可接着做。管理员可在系统设置中调整上限。"
    ],
    "websocket_failed": [
        "对话连接不可用",
        "请检查网络及反向代理的 WebSocket 配置后重连。"
    ],
    "internal_error": [
        "服务暂时无法完成操作",
        "请将操作编号交给管理员排查。"
    ]
};
// Known messages from older JSON endpoints and the bundled upgrade helper.
const legacyErrors = new Set([
    "目标目录中已存在同名文件或目录",
    "账号出口代理已停用",
    "账号出口代理尚未就绪",
    "请输入有效的 HTTP / HTTPS 地址",
    "无法读取容器状态",
    "请重新启动浏览器以应用当前网络设置",
    "剪贴板最多支持 48 KiB 的文字",
    "请先连接浏览器",
    "授权或网络配置已变更，请重新连接浏览器",
    "地址格式无效",
    "仅支持不含用户名密码的 HTTP / HTTPS 地址",
    "显示服务启动超时",
    "显示服务启动失败",
    "浏览器代理配置无效",
    "浏览器启动失败，请检查镜像及用户命名空间沙箱支持",
    "远程桌面启动超时",
    "剪贴板内容过长",
    "打开网页失败",
    "未知操作",
    "浏览器未运行",
    "浏览器尚未完全停止，请稍后重试",
    "浏览器网络切换超时，请停止工作空间后重试",
    "浏览器启动超时",
    "工作空间未运行",
    "终端已结束或正在关闭",
    "请求体格式错误",
    "切换回兼容代理模式前，请先停止运行中的工作空间",
    "该账号类型不使用 OAuth 登录",
    "账号未配置 credentials_dir",
    "正在完成授权，请稍后重试",
    "缺少授权码",
    "授权已过期，请重新生成授权链接",
    "state 不匹配，请重新生成授权链接",
    "令牌响应解析失败",
    "API Key 为空或含非法字符",
    "wire_api 只能是 responses 或 chat",
    "该账号类型不使用 API Key",
    "仅 claude 账号支持清除中转站配置",
    "Base URL 含非法字符",
    "Base URL 必须是 http(s)://host[/path] 形式",
    "请先输入 API Key（或保存过一次后可留空）",
    "暂时无法读取升级任务，请稍后刷新。",
    "请选择有效的正式版本。",
    "无效的升级请求。",
    "版本检查结果已变化，请重新检查更新后升级。",
    "升级提交结果尚未确认，请刷新任务状态并检查服务器日志。",
    "存储附加配置需要受支持的 storage_policy.mount，请使用手工升级。",
    "存在未识别的服务附加配置，请使用手工升级。",
    "存储附加配置的属主或权限不安全，请使用手工升级。",
    "存储附加配置内容不匹配，请使用手工升级。",
    "存储挂载或配额保护尚未实际生效，请使用手工升级。",
    "运行中的服务仍可能绕过磁盘配额，请使用手工升级。",
    "一键升级需要以 root 运行的 Linux/systemd 发布安装。",
    "当前架构或版本标识不支持一键升级，请使用手工升级。",
    "服务器缺少 systemd-run，请使用手工升级。",
    "当前服务不是标准版本目录安装，请使用手工升级。",
    "当前安装的构建信息不匹配，请使用手工升级。",
    "服务单元经过自定义或使用旧布局，请使用手工升级。",
    "正在运行的服务与发布安装不一致，请使用手工升级。",
    "升级状态文件损坏，请检查服务器。",
    "升级任务已退出或服务器曾重启，请查看任务日志后重试。",
    "只能升级到更新的正式版本，请重新检查更新。",
    "已有其他版本的升级任务正在执行。",
    "升级提交结果尚未确认，请刷新任务状态，不要手工替换程序。",
    "已有部署或升级操作正在执行，请稍后刷新。",
    "无法提交或读取升级任务，请刷新状态并检查服务器日志。",
    "浏览器返回无效状态",
    "浏览器操作失败",
    "剪贴板操作失败",
    "当前部署不是支持在线升级的版本目录安装，请使用手工升级。",
    "一键升级需要以 root 运行的 Linux/systemd 版本目录安装；当前环境请手工升级。",
    "服务器缺少 Python 3，请使用手工升级。",
    "连接已被服务端拒绝",
    "当前用户无权使用该账号，请联系管理员调整账号使用范围",
    "请粘贴完整的 http://localhost:1455/auth/callback?... 回调地址",
    "state 不匹配，请使用本次授权的完整回调地址",
    "授权未完成，请重新打开授权链接并同意授权",
    "回调地址缺少授权码",
    "无法构造令牌请求",
    "请求令牌接口失败，请检查账号出口代理或网络",
    "令牌响应不完整，请重新授权",
    "账号 ID 不合法：小写字母或数字开头，可含 - 和 _，长度 2-32",
    "账号类型必须是 claude 或 codex",
]);
const legacyDetailPrefixes = [
    "请求令牌接口失败: ",
    "登录成功但清除中转站配置失败: ",
    "连接失败: ",
    "保存凭证失败，请重新授权：",
    "浏览器操作失败，请检查镜像、内存和 Chrome 沙箱支持: ",
];
export function localizeLegacyError(message, translate) {
    if (legacyErrors.has(message))
        return translate(message);
    const prefix = legacyDetailPrefixes.find(value => message.startsWith(value));
    if (prefix)
        return translate(prefix + "{detail}", { detail: message.slice(prefix.length) });
    const exchange = /^换取令牌失败 [(]HTTP (\d{3})[)]: ([\s\S]*)$/.exec(message);
    if (exchange)
        return translate("换取令牌失败 (HTTP {status}): {detail}", { status: exchange[1], detail: exchange[2] });
    const reauthorize = /^换取令牌失败 [(]HTTP (\d{3})[)]，请重新授权$/.exec(message);
    if (reauthorize)
        return translate("换取令牌失败 (HTTP {status})，请重新授权", { status: reauthorize[1] });
    const quota = /^额度已用完（余额 (.+)），请联系管理员充值后再继续$/.exec(message);
    if (quota)
        return translate("额度已用完（余额 {balance}），请联系管理员充值后再继续", { balance: quota[1] });
    return message;
}
const validID = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
export function formatProblem(problem, translate, fallback = "") {
    const known = problem.code && Object.hasOwn(problemMessages, problem.code) ? problemMessages[problem.code] : undefined;
    const message = known ? translate(known[0]) : (typeof problem.error === "string"
        ? (problem.code ? problem.error : localizeLegacyError(problem.error, translate))
        : fallback);
    const hint = known ? translate(known[1]) : (typeof problem.hint === "string" ? problem.hint : "");
    const reference = validID(problem.operation_id) ? translate("操作编号：{id}", { id: problem.operation_id }) : "";
    return [message, hint, reference].filter(Boolean).join(" ");
}
export class APIError extends Error {
    problem;
    status;
    constructor(problem, status, translate, fallback) {
        super(formatProblem(problem, translate, fallback));
        this.problem = problem;
        this.status = status;
        this.name = "APIError";
    }
}
export async function responseError(response, translate, fallback = response.statusText) {
    let problem = {};
    try {
        const body = await response.json();
        if (body && typeof body === "object" && !Array.isArray(body))
            problem = body;
    }
    catch { /* Old proxy errors may be non-JSON. */ }
    if (!validID(problem.operation_id)) {
        const id = response.headers.get("X-Agentbox-Operation-ID");
        if (validID(id))
            problem.operation_id = id;
    }
    return new APIError(problem, response.status, translate, fallback || translate("服务暂时无法完成操作"));
}
