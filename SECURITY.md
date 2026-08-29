# Security Policy

## 密钥与私密数据

API key、API 密钥和其他任何秘密都不得进入仓库文件、命令行参数、日志、账本、录屏、失败运行证据或验收产物。密钥只能通过环境变量传给需要它的受控子进程，不得复制、打印或持久化。

提示词和评审输入写入权限模式为 `0600` 的私有临时文件，其父目录权限模式为 `0700`。创建这些文件的代码必须在 `finally` 中删除它们，包括成功、失败、取消和异常退出路径。

## 模型调用披露

任何外部模型调用发生前，SuperPPT 必须向用户披露提供者和全部出站数据，包括发送的文本、提示词、参考图、页数、最大调用次数和输出位置。未完成披露时不得发起调用。

## 客户验收信任根与迁移

客户验收的安装级信任边界位于项目目录之外的 SuperPPT 授权信任库。每个项目的不可变 V1 基础注册、分版签名的 root-authority state/head/current 历史、每轮验收注册、事件/head 链和 registry high-water 共同构成受信状态。Root authority 承诺已初始化状态、单调注册序号、当前注册集摘要和 pending/completed 验收 high-water。任何缺失、降级、签名或前驱错误、非 `0600` 文件、非 `0700` 目录、符号链接或与子注册/事件/registry 不一致的状态都必须 fail closed。

旧 V1 基础注册存在但 root authority 缺失时，普通读取和修改不得自动创建或推进信任状态。只有在 generation lease 内执行的显式 legacy-acceptance 迁移，才能根据完整存活的签名 V1 pending/completed 链创建精确的每轮注册并追加新 high-water；它不重写旧 event、head 或 registry state。如果本地 manifest 仍有 transaction、ready/completed smoke anchor、delivered 状态或最终验收产物，但外部信任根或应有的旧链已经缺失，必须要求信任恢复，不得根据可变本地证据合成历史。

本模型的 TCB 包含外部 HMAC 密钥和固定的签名 root-authority current 及其追加历史。当子树、registry 尾或项目副本仍存在时，root 丢失/回滚会被检测并 fail closed。如果攻击者同时彻底销毁或替换整个外部信任根、密钥和所有项目验收证据，这属于 TCB 完全失陷；SuperPPT 不宣称在该假设下具备数学上的防回滚能力。

## 泄露响应

一旦怀疑密钥或秘密暴露，立即停止执行，不得用原密钥重试。必须先在提供者侧撤销并轮换密钥，完成相关证据清理和影响评估后，才能重新执行。

请不要在公开 issue 中提交密钥、私密数据或可利用的漏洞细节。请通过仓库所有者的私密安全联络渠道报告，并提供最小化的复现信息。
