# 飞书应用的主人和管理员怎么查

2026-10-14。主人在问答第 10 题定了：bot 的主人和管理员沿用飞书应用自己的所有者和管理员，直接查，本地可以缓存。这里记下飞书开放平台上能用的接口。资料来自飞书开放平台文档的 JSON 接口（`open.feishu.cn/document_portal/v1/document/get_detail`），文档页本身是脚本渲染的，直接抓取拿不到正文。

## 两个接口

| 接口 | 能拿到什么 | 权限 | 令牌 | 频率限制 |
|---|---|---|---|---|
| 获取应用信息 `GET /open-apis/application/v6/applications/:app_id`，只查自己时 `:app_id` 可以填 `me` | `owner.owner_id` 和 `owner.type`（0 飞书科技，1 飞书合作伙伴，2 企业内成员），以及 `creator_id`（应用创建者） | `application:application:self_manage`（管理应用自身资源）或 `admin:app.info:readonly`（这个接口页叫"获取应用信息"），二选一 | 只支持 `tenant_access_token` | 50 次/秒 |
| 获取应用协作者列表 `GET /open-apis/application/v6/applications/:app_id/collaborators` | `collaborators[]`，每项是 `type` 和 `user_id`。`type` 只有 `administrator`（管理员）、`developer`（开发者）、`operator`（运营）三种，所有者从上一个接口拿 | 同上，二选一 | `tenant_access_token` 或 `user_access_token` | 10 次/分钟 |

两个接口都用查询参数 `user_id_type` 选 ID 类型，默认 `open_id`。取 `user_id` 时还要 `contact:user.employee_id:readonly`，用默认的 `open_id` 不需要。用 bot 自己的应用身份查，返回的 open_id 和这个 bot 收到的消息里的发信人 open_id 是同一套。

协作者接口的说明里写了三种用法：

- 用 `tenant_access_token` 加"管理应用自身资源"权限，只能查应用自己的协作者。vonvon 只需要这一种。
- 用 `tenant_access_token` 加"获取企业内全部应用的信息"，能查企业内任何自建应用和商店应用的协作者。
- 用 `user_access_token` 时，那个用户本人必须是应用的协作者。

## 用在 vonvon-bot 上

- 主人是 `owner.owner_id`。协作者里 `type` 为 `administrator` 和 `developer` 的人算管理员，`operator`（运营）不算。主人后来补充说，扫码把应用加进 vonvon 的人，飞书在扫码时已经确认过是管理员或开发者；产品上的定法见 `docs/product.md` 第 6 节。
- 现在的代码不申请这个权限。今天的主人是扫码建应用时那个人的 open_id（`creds.operatorOpenId`，`packages/daemon/src/bot/wizard.ts:81`），管理员来自本机配置 `preferences.access.admins`（`packages/daemon/src/bot/refresh-bot.ts:34`）。
- 建议把 `application:application:self_manage` 设成可选权限。缺这个权限，或者接口出错时，退回认扫码的人为主人。
- 协作者接口每分钟只能调 10 次，所以要缓存。建议缓存 10 分钟；陌生人私聊时最多每分钟强制刷新一次。在飞书里去掉一个管理员，最多 10 分钟后这个人就不能私聊了。

## 还不知道的

- 企业租户里这个权限要不要管理员审核，要在真实租户上试。
- 应用所有者转让以后（`PUT /open-apis/application/v6/applications/:app_id/owner`），应用信息里的 `owner` 多久更新，没有试过。
- 应用信息接口的说明写着：商店应用要正式发布才能调用，灰度发布时会报 210504。vonvon 的 bot 都是自建应用，这条应该不影响，没有实测。
