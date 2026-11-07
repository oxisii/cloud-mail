# MCP 服务

Cloud Mail 提供一个无状态的 MCP（Model Context Protocol）端点。管理员在系统设置里打开开关并生成访问令牌后，客户端可以用 JSON-RPC 调用项目里已经存在的业务接口。MCP 不另写 SQL，每个工具都直接调用对应的 service

令牌通过后，服务按 `c.env.admin` 查出管理员用户并写入请求上下文。邮件、邮箱、星标、当前用户这类依赖登录身份的接口，都以这个管理员身份执行。MCP 令牌等同管理员权限

## 开启步骤

1. 部署包含本功能的版本后，用原来的初始化地址重新执行一次数据库初始化。初始化会补上 `setting.mcp_status` 和 `setting.mcp_token` 两列，已有列会跳过
2. 用管理员账号登录，打开「系统设置」
3. 找到 MCP 卡片，点齿轮打开设置
4. 打开启用开关。约定与其它设置相同：`0` 是开启，`1` 是关闭
5. 点「生成令牌」。令牌只在这个弹窗里完整显示，通用的设置查询会把令牌打码
6. 复制接入端点、令牌或客户端配置。已有令牌时再生成会先确认，确认后旧令牌立即失效。撤销会清空令牌，开关即使开着也不能调用，直到重新生成

## 端点与鉴权

- 地址：`POST /mcp`。Worker 入口把 `/mcp` 原样交给后端，不要加 `/api` 前缀
- `GET /mcp` 返回 HTTP 405
- 协议是 JSON-RPC 2.0，只实现 `initialize`、`ping`、`tools/list`、`tools/call`，以及 `notifications/*`。不引入 MCP SDK
- `initialize` 优先回显客户端带来的 `protocolVersion`，没有则使用 `2025-03-26`。`capabilities` 只声明 tools，服务名是 `cloud-mail`
- `notifications/*` 返回 HTTP 204，没有正文。`ping` 的结果是 `{}`
- 非法 JSON 返回 `-32700`，未知方法返回 `-32601`，未知工具或参数不合法返回 `-32602`
- `tools/call` 成功时，`content` 是一段 JSON 文本，`structuredContent` 是对应 service 的返回值，与 REST 接口 `result.ok` 里的 `data` 相同。业务异常不返回 HTTP 500，而是 `isError: true`，正文为错误消息

请求头 `Authorization` 放访问令牌，也可以写成 `Bearer <令牌>`。校验顺序：

1. 未开启（`mcpStatus` 不是 `0`）返回 HTTP 403
2. 令牌为空、请求没带令牌或令牌不一致返回 HTTP 401
3. 通过后按管理员身份继续

项目其它接口的业务错误写在 JSON 的 `code` 字段里，HTTP 状态仍是 200。MCP 鉴权失败按上面的 HTTP 状态返回，方便客户端识别

## 客户端配置示例

把 `url` 换成站点源加上 `/mcp`，`Authorization` 换成面板里的令牌：

```json
{
  "mcpServers": {
    "cloud-mail": {
      "type": "streamable-http",
      "url": "https://your-domain.example/mcp",
      "headers": {
        "Authorization": "<令牌>"
      }
    }
  }
}
```

## 工具一览

共 49 个工具。下表「破坏性」为是的操作不可恢复，调用前需要确认参数

| 工具 | 对应 REST | 参数要点 | 破坏性 |
| --- | --- | --- | --- |
| email_list | GET /email/list | accountId 必填，另有 emailId、type、size、timeSort、allReceive、full、text、searchType、startDate、endDate | 否 |
| email_latest | GET /email/latest | emailId、accountId、allReceive | 否 |
| email_read | PUT /email/read | emailIds 为数字数组 | 否 |
| email_send | POST /email/send | accountId、receiveEmail 必填，附件字段原样透传，另有 name、sendType、emailId、manyType、text、content、subject | 否 |
| email_delete | DELETE /email/delete | emailIds 为逗号分隔字符串 | 是 |
| email_att_list | GET /email/attList | emailId。只返回附件元信息，文件仍走原来的存储地址 | 否 |
| all_email_list | GET /allEmail/list | emailId、size、name、subject、accountEmail、userEmail、type、timeSort、full | 否 |
| all_email_latest | GET /allEmail/latest | emailId | 否 |
| all_email_delete | DELETE /allEmail/delete | emailIds 为逗号分隔字符串 | 是 |
| all_email_batch_delete | DELETE /allEmail/batchDelete | sendName、sendEmail、toEmail、subject、startTime、endTime、type（eq / left / include） | 是 |
| public_email_list | POST /public/emailList | toEmail、content、subject、sendName、sendEmail、timeSort、num、size、type、isDel | 否 |
| public_add_user | POST /public/addUser | list，元素含 email，可选 password、roleName | 否 |
| account_list | GET /account/list | accountId、size、lastSort | 否 |
| account_add | POST /account/add | email 必填，开启人机验证时带 token | 否 |
| account_set_name | PUT /account/setName | accountId、name | 否 |
| account_set_all_receive | PUT /account/setAllReceive | accountId | 否 |
| account_set_as_top | PUT /account/setAsTop | accountId | 否 |
| account_delete | DELETE /account/delete | accountId | 是 |
| user_list | GET /user/list | num、size、email、timeSort、status、isDel | 否 |
| user_all_account | GET /user/allAccount | userId 必填，另有 num、size | 否 |
| user_add | POST /user/add | email、password 必填，type 为角色 id | 否 |
| user_set_pwd | PUT /user/setPwd | userId、password。会修改用户密码 | 否 |
| user_set_status | PUT /user/setStatus | userId、status | 否 |
| user_set_type | PUT /user/setType | userId、type | 否 |
| user_reset_send_count | PUT /user/resetSendCount | userId | 否 |
| user_restore | PUT /user/restore | userId 必填，type 有值时连同已删邮件和邮箱一起恢复 | 否 |
| user_delete | DELETE /user/delete | userIds 为逗号分隔字符串 | 是 |
| user_delete_account | DELETE /user/deleteAccount | accountId | 是 |
| role_list | GET /role/list | 无 | 否 |
| role_tree | GET /role/tree | 无 | 否 |
| role_select_use | GET /role/selectUse | 无 | 否 |
| role_add | POST /role/add | name、permIds、banEmail、availDomain 必填，另有 description、sort、sendType、sendCount、accountCount、banEmailType | 否 |
| role_set | PUT /role/set | roleId、name、permIds、banEmail、availDomain 必填，其余字段同添加 | 否 |
| role_set_default | PUT /role/setDefault | roleId | 否 |
| role_delete | DELETE /role/delete | roleId。该角色下的用户会改到默认角色 | 是 |
| reg_key_list | GET /regKey/list | code 为前缀，可省略 | 否 |
| reg_key_history | GET /regKey/history | regKeyId | 否 |
| reg_key_add | POST /regKey/add | code、roleId、count、expireTime | 否 |
| reg_key_delete | DELETE /regKey/delete | regKeyIds 为逗号分隔字符串 | 是 |
| reg_key_clear_not_use | DELETE /regKey/clearNotUse | 无。删除用尽或过期的注册码 | 是 |
| star_list | GET /star/list | emailId、size、full | 否 |
| star_add | POST /star/add | emailId | 否 |
| star_cancel | DELETE /star/cancel | emailId | 否 |
| setting_query | GET /setting/query | 无。密钥打码，不含完整 MCP 令牌 | 否 |
| setting_website_config | GET /setting/websiteConfig | 无 | 否 |
| setting_set | PUT /setting/set | 设置字段按需传入，可改全站配置。不要把打码后的密钥写回去 | 否 |
| setting_set_blacklist | PUT /setting/setBlacklist | blackSubject、blackContent、blackFrom | 否 |
| analysis_echarts | GET /analysis/echarts | timeZone，例如 Asia/Shanghai | 否 |
| my_login_user_info | GET /my/loginUserInfo | 无。返回管理员资料 | 否 |

分组数量：邮件 6、全站邮件 4、开放 API 2、邮箱账号 6、用户管理 10、角色 7、注册码 5、标星 3、系统设置 4、数据分析 1、当前用户 1

## 不开放的接口

下面 16 个接口不做 MCP 工具。对应能力要么已由其它工具覆盖，要么不属于给客户端调用的业务

- POST /public/genToken：这是签发开放 API 令牌的接口。MCP 令牌由系统设置面板生成
- POST /login、POST /register、DELETE /logout：登录和会话本身。MCP 用访问令牌代替登录
- POST /oauth/linuxDo/login、POST /oauth/github/login、POST /oauth/google/login、PUT /oauth/bindUser：第三方登录和绑定，同样由令牌代替
- GET /init/:secret：部署初始化，不能从 MCP 暴露
- POST /webhooks：Resend 的入站回调，自带校验，不是给 MCP 客户端调用的
- GET /telegram/getEmail/:token：Telegram 入站回调，自带令牌
- GET /oss/*：二进制下载。MCP 只通过 email_att_list 给出附件元信息，文件仍走原来的地址
- PUT /setting/setBackground、DELETE /setting/deleteBackground：背景图是文件上传和删除，这一版不做。其余设置由 setting_set 覆盖
- PUT /my/resetPassword、DELETE /my/delete：改自己的密码、注销自己。管理员改密码和删除用户已经由 user_set_pwd、user_delete 覆盖，这两个入口风险更高，不单独开放

## 安全注意事项

令牌和超级管理员是同一权限，可以读邮件、改设置、删除用户。只放在受信任的客户端里，不要写进仓库、截图或公开对话。轮换后旧令牌马上失效。不再使用时先撤销令牌，再关掉开关。通用设置查询里的令牌是打码的，完整值只从 MCP 设置弹窗读取
