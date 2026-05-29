# chatgpt-reoauth

纯 Chrome 扩展，用来给 sub2api 里的 OpenAI OAuth 账号做 401 重新授权刷新。

扩展后台直接调用 sub2api 管理接口，内容脚本接管 OpenAI OAuth 页面，邮箱验证码由扩展托管的 Outlook/Hotmail 账号池读取。

## 安装

1. 打开 [Releases](https://github.com/minori0721/chatgpt-reoauth/releases)
2. 下载 `chatgpt-reoauth-vx.x.x.zip`
3. 解压压缩包
4. 打开 Chrome `chrome://extensions`
5. 打开“开发者模式”
6. 点击“加载已解压的扩展程序”
7. 选择解压后的 `chatgpt-reoauth-vx.x.x` 文件夹
8. 点击扩展图标打开侧边栏



## 使用

1. 填 sub2api 地址、管理员邮箱和密码
2. 导入 Hotmail/Outlook 托管邮箱池
3. 点击“扫描 401”
4. 点击“开始刷新”

“操作延迟”默认开启，页面输入、点击、授权、验证码提交后会停顿约 2 秒，批量跑号时更稳。如果你想跑快，可以把延迟关掉或调小。

刷新流程会在侧边栏显示为“当前账号刷新流程”，只显示正在处理的这一个账号，处理下一个账号时同一套步骤会重置：

```text
扫描 sub2api OpenAI 账号
→ 找到 401 / unauthorized / token_invalidated
→ 先调用 sub2api 自带 refresh
→ refresh 失败则生成 OpenAI OAuth 授权链接
→ Chrome 标签页打开授权链接
→ 内容脚本用托管邮箱账号收验证码、填写验证码、点击继续授权
→ 扩展捕获 localhost OAuth callback
→ 扩展调用 sub2api exchange-code
→ 扩展调用 apply-oauth-credentials 更新原账号
```

## 托管邮箱导入格式

每行一条，兼容常见格式：

```text
邮箱----密码----客户端ID----刷新令牌
```

这里当前主要使用：

```text
邮箱----客户端ID----刷新令牌
```

示例：

```text
main@outlook.com----00000000-0000-0000-0000-000000000000----M.R3_BAY...
```

也兼容你从表格里复制出来的两行格式：

```text
main@outlook.com
00000000-0000-0000-0000-000000000000
```

但这个格式只有 `client_id`，没有 `refresh_token`，只能先导入邮箱壳子，不能自动读取验证码。要让扩展自动取码，最终仍然需要导入 Microsoft 邮箱可用的 `refresh_token`。

如果 sub2api 账号是 `main+pp2@outlook.com`，扩展会把它匹配到 `main@outlook.com` 这个托管邮箱。取码时会优先检查邮件内容里是否出现目标邮箱，避免 `+pp4` 误拿 `+pp3` 的验证码。

API 对接取码逻辑做了这些兼容：

- 使用 `declarativeNetRequest` 规则移除 Microsoft token 请求的 `Origin` 头，避免浏览器扩展触发 AADSTS90023
- 按 Graph / Outlook API 多策略读取完整邮件正文，不只看 `bodyPreview`
- OpenAI 出现“欢迎回来 / 选择账号”页时，只会点击与当前目标邮箱匹配的账号；如果页面里是上一个号，会自动点“登录至另一个账户”
- 允许邮件只发到主邮箱 `main@outlook.com`，同时会拦截同主邮箱的错误别名，比如 `main+pp3@outlook.com`
- 等待较久仍无新码时，会尝试点击 OpenAI 页面里的重新发送验证码
- Microsoft 返回新邮箱 `refresh_token` 时会自动轮换保存
- 每个账号处理完会关闭本次 OAuth 标签页，并在账号之间按“操作延迟”停顿，减少旧登录态和页面切换互相影响
- 如果 OpenAI 返回 `account_deactivated` / 账号已停用，会跳过这个账号并加入“待确认删除”清单，不会自动删除；你可以等全部跑完后再确认删除 sub2api 里的旧账号

## 注意

- 这版不走 codex-session 导入。
- 这版不会自动删除 sub2api 账号；只有你在“待确认删除”里二次确认后，才会删除已停用账号对应的远端旧账号。
- 如果 OpenAI 页面出现额外风控、人机验证或必须人工选择账号，扩展会停在当前标签页，让你人工接一下后继续捕获 callback。

## 致谢

部分流程设计参考了 [FoundZiGu/GuJumpgate](https://github.com/FoundZiGu/GuJumpgate) 的实现思路，感谢原项目作者和相关开源工作。
