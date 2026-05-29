# chatgpt-reoauth v0.1.0

首个公开版本。`chatgpt-reoauth` 是一个纯 Chrome 扩展，用来给 sub2api 里的 OpenAI OAuth 账号做 401 重新授权刷新。

## 下载与安装

1. 在本页面下方 Assets 下载 `chatgpt-reoauth-v0.1.0.zip`
2. 解压压缩包
3. 打开 Chrome `chrome://extensions`
4. 打开“开发者模式”
5. 点击“加载已解压的扩展程序”
6. 选择解压后的 `chatgpt-reoauth-v0.1.0` 文件夹
7. 点击扩展图标打开侧边栏

## 主要功能

- 扫描 sub2api OpenAI OAuth 账号，识别 401 / unauthorized / token invalidated 状态
- 优先尝试 sub2api 已保存的 refresh token 刷新
- refresh 失败时自动打开 OpenAI OAuth 授权页重新授权
- 支持 Outlook / Hotmail 托管邮箱池读取邮箱验证码
- 支持 `main+tag@outlook.com` 自动匹配 `main@outlook.com` 主邮箱，并尽量避免别名验证码串号
- 捕获 OAuth callback 后调用 sub2api exchange-code，并更新原账号凭证
- 对账号已停用、手机号/WhatsApp 验证、邮箱 token/权限失效等情况自动跳过并记录结果
- 账号已停用时只加入“待确认删除”清单，不自动删除远端账号
- 提供配置导入/导出，方便迁移 sub2api 配置和邮箱池
- 使用 Chrome 本地存储保存配置，运行态使用 session 存储，减少刷新页面后的半截任务残留

## 使用提醒

- 配置导出文件会包含 sub2api 密码和邮箱 refresh token，请只保存在可信位置
- 当前版本没有接码流程，遇到手机号/WhatsApp 验证会跳过
- 如果 OpenAI 出现额外风控或需要人工选择账号，扩展会停在当前标签页，用户可以手动接一下
- 批量刷新前建议先少量测试，确认 sub2api 地址、管理员账号和托管邮箱池都可用

## 验证

- `node --check extension/background.js`
- `node --check extension/content/auth.js`
- `node --check extension/sidepanel/sidepanel.js`
- 已检查 manifest JSON 解析
- 已检查 release zip 结构可直接作为 Chrome 已解压扩展加载

## 致谢

部分流程设计参考了 [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate) 的实现思路，感谢原项目作者和相关开源工作。
