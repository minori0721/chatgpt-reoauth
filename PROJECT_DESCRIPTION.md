# 项目简介

`chatgpt-reoauth` 是一个用于 sub2api OpenAI OAuth 账号 401 自动重新授权的 Chrome 扩展。它可以扫描 sub2api 中失效的 OpenAI OAuth 账号，尝试 refresh token 刷新；刷新失败时自动打开 OpenAI OAuth 授权页，通过托管 Outlook / Hotmail 邮箱池读取验证码并完成重新授权，最后把新凭证写回原 sub2api 账号。

适合需要批量维护 sub2api OpenAI OAuth 账号、处理 `token_invalidated` / `refresh_token_reused` / `refresh_token_invalidated` 等失效状态的场景。

## 核心能力

- sub2api 401 账号扫描与批量处理
- refresh token 优先刷新，失败后走浏览器 OAuth 重新授权
- Outlook / Hotmail API 对接读取邮箱验证码
- 支持邮箱别名匹配，降低 `+tag` 别名串码概率
- OAuth callback 捕获、exchange-code、apply credentials 写回 sub2api
- 停用账号、手机号验证、邮箱 token 异常等情况自动跳过并记录
- 已停用账号删除前二次确认
- 配置导入/导出，便于迁移 sub2api 配置和邮箱池
- 纯 Chrome 扩展，无需 Node helper

## 安装

从 Releases 下载 `chatgpt-reoauth-v0.1.0.zip`，解压后在 Chrome `chrome://extensions` 中启用开发者模式，选择解压后的文件夹加载即可。

## 致谢

部分流程设计参考了 [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate) 的实现思路，感谢原项目作者和相关开源工作。
