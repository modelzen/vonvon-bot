# 旧 OAuth 调研副本

来源：原 Claude 会话在 2026-11-13 形成的报告。本文件是历史材料，未在本次交接中重新核验全部事实。报告中的登录方式推荐早于用户最后决定，接续时以 README 和原对话 L840 为准：先上 GitHub、Google、Apple，不用 QQ；身份服务希望托管，Supabase 待评估。服务商准入、价格、网络可用性及法律判断均需在采纳前重新核实。

---

# 核查结果（2026-11-13，只读：没有注册、没有提交申请、请求里没带 owner 信息）

核查方式：直接读官方文档原文（飞书、钉钉、微信的 .md 源文件，QQ 互联 wiki，抖音、企业微信、微博、GitHub、Google 官方页面）。大陆可达性用 GreatFire 和 OONI 两个独立的测量来源交叉看。临时目录已经按删除规矩删掉了（`/tmp/tmp.fKbhKg19Tk`）。

---

## 1）飞书：不做 ISV、不上架商店，其他租户的用户能不能登录

**结论：不能。** 唯一不靠 ISV 的办法是"绑定"，不能当真正的登录用。和调研代理**一致**。

- **自建应用不跨租户。** 原文："企业自建应用……只能在同一企业内发布和使用"；"**自建应用只可在应用开发者所在的租户内使用**"。来源：[应用类型](https://open.feishu.cn/document/home/app-types-introduction/overview)、[用户身份 ID 说明](https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/larkid)。可信度 high。
- **外租户用户登录会报错。** token 接口的错误码：20009"租户未安装应用"，20010"用户无应用使用权限"。来源：[获取 user_access_token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)。可信度 high。
- **同一个人在不同租户是不同身份。** 原文："User ID 不相同的话，Open ID 和 Union ID 也都是隔离的"。所以飞书身份是按租户算的，不是按人算的。可信度 high。
- **商店应用只有 ISV 能建。** llms.txt 原文："仅拥有 ISV 资质的用户可以创建商店应用"。来源：[llms.txt](https://open.feishu.cn/llms.txt)。可信度 high。
- **ISV 入驻条件原文**（[入驻页](https://open.feishu.cn/document/isv-guides/publish-your-app/step1-complete-the-entry)，high）：
  - "企业成立1年以上"；
  - "成熟商业化6个月以上，服务客户超过50家"；
  - "不少于3人团队"；
  - "完成飞书企业租户认证"；
  - "仅作为企业管理员的正式员工可以为企业申请"；
  - "飞书将在 3 个工作日内完成审核"；
  - 材料：营业执照（有效期半年以上）、法人身份证、盖公章的授权证明。
- **上架规则**（[上架页](https://open.feishu.cn/document/isv-guides/publish-your-app/step7-publish-the-store-application)，high）：
  - "公开上架的付费应用，缴纳保证金2万元/应用"；
  - 首次发布只能灰度；
  - "该应用登录必须通过 SSO 单点登录……不允许……通过其他的账号体系登录"，和 vonvon 同时支持多种登录方式可能冲突；
  - 灰度上限两处写法不一：可见范围那里写"上限为30个租户"，添加灰度企业那里写"最多能添加 200 个"。原文确实如此，调研代理没有说错。
- **变通 B（官方"对外共享"机器人）原文属实**（[对外共享](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group)，high）：
  - "仅支持企业自建应用"；
  - 开启前要企业认证或个人实名认证；
  - "无法获取外部用户身份（即外部用户的 user_access_token）"；
  - 飞书个人版"支持"单聊，客户端要 V7.22 以上。
  - 所以它只能用来绑定 open_id，不是 OAuth 登录。
- **变通 A（官方"一键创建应用"）**：基于 "OAuth 2.0 Device Authorization Grant（RFC 8628）"，返回 client_id、client_secret 和可选的 `user_info.open_id`。来源：[一键创建应用](https://open.feishu.cn/document/mcp_open_tools/scan-to-create-an-app-in-one-click)，原文 high。但"让用户用自己租户里的应用来证明飞书身份"是推断出来的方案，官方既没说支持也没说禁止，low。

## 2）微信网站应用登录

**结论：要非个人主体，过三道审核；桌面端只能经 vonvon.cc 服务端回调再交还给 App。** 和调研代理**大体一致**，有三处要修正。

- **前置条件：**
  - 官方原文："拥有一个已审核通过的网站应用……申请微信登录且通过审核后，可开始接入"。来源：[网站应用微信登录](https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/web.html)，high。
  - 现行开发文档没有明写"必须完成开发者资质认证"。不过审核规范 4.5 要求官网信息"与微信开放平台开发者资质认证主体信息一致"；社区回复写"个人不支持认证开发者资质，但有营业执照的个体户可以"。来源：[应用审核规范](https://developers.weixin.qq.com/doc/oplatform/Website_App/operation.html)、[社区问答](https://developers.weixin.qq.com/community/minihome/doc/000806d3d48098813fcae28695c800)。
  - 所以"要公司或个体户，并完成资质认证"可信度 **medium**（调研代理标的是 high）。owner 有公司，这一条对决策影响不大。
- **费用：**
  - 腾讯客服官方页写"认证费：300元/次"，页面较老。来源：[kf.qq.com](https://kf.qq.com/faq/1612267j2eQ3161226jIVbA3.html)，medium。
  - 开放平台资质认证要不要每年年审，没找到原文，low。小程序和公众号的微信认证明确是"一年内发起并完成年审"（[认证指引](https://developers.weixin.qq.com/miniprogram/product/renzheng.html)），但那是另一套认证。
  - 网站应用和微信登录本身不另收费。
- **回调域名**（[网站应用管理](https://developers.weixin.qq.com/doc/oplatform/developers/product/webapp/)，high）：
  - "每个网站应用支持配置最多 1 个授权回调域名"，"每个月最多可修改 5 次"；
  - 只填域名，不带协议头；
  - 有"仅域名 / 仅地址 / 兼容"三种校验模式。
- **修正 1：** "redirect_uri 不支持带端口号（10003）"这句原文在[排错页](https://developers.weixin.qq.com/doc/oplatform/developers/troubleshooting/auth.html)里，讲的是**服务号网页授权**，不是网站应用。结论不变：回调只能落在登记的域名下，没法直接回到 环回地址:端口 或自定义协议。只是出处要改。
- **修正 2（备案和主体）：**
  - 审核规范 2.1：主体不一致时附授权书，"加盖双方公司公章，**个人主体则签名即可**"。所以授权书路线有原文依据，调研代理说没找到。
  - 但 8.2、8.5 又要求《网站信息登记表》的"公章需与登记表内主办单位/微信开放平台认证主体一致"，"备案需与登记表内主办单位一致"。
  - 腾讯云备案文档（2026-07-23 更新）写明："个人备案：网站内容需符合个人备案性质，**不能涉及企业、团体**……"（[腾讯云](https://cloud.tencent.com/document/product/243/19644)，high）。
  - 结论：**建议把 vonvon.cc 的备案主体改到公司名下**，可信度 medium-high。
- **桌面 App：**
  - 官方不禁止。电脑上登着 Windows 3.9.11+ 或 Mac 4.0.0+ 的微信时能快速登录（原文，high）。
  - "浏览器扫码 → vonvon.cc 服务端回调 → deep link 或轮询交回 App"是架构上的推断，medium。
  - 2025 年新出的「桌面应用」扩展只是"微信内网页拉起桌面应用"，要已认证服务号和签名或 Bundle ID 校验，跟登录无关（原文，high）。
- **修正 3（小程序码登录这条路）：** 小程序码接口有错误码 85412"personal entity not verified"，解决方案原文是"**个人小程序须通过主体认证后，可生成并使用小程序码**"。来源：[getUnlimitedQRCode](https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/qr-code/api_getunlimitedqrcode.html)，high。调研代理说"接口没写主体限制、个人现在就能做"，这是错的。
- **手机号：** 手机号快速验证组件"针对非个人主体，且完成了认证的小程序开放"；2023-08-28 起每次成功调用 0.03 元，有 1000 次体验额度。来源：[getPhoneNumber](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)，high。

## 3）火山引擎有没有面向第三方的账号登录

**结论：没找到。** 和调研代理**一致**。

- 能查到的火山 IAM SSO 和 OAuth，都是企业自己的身份系统当 IdP、火山当 SP，用来登录火山控制台（入站）。Pulumi 上的 `iam/oauthprovider` 资源配的也是外部 IdP 的授权、token、userinfo 地址，方向同样是入站。来源：[Pulumi volcenginecc OAuthProvider](https://www.pulumi.com/registry/packages/volcenginecc/api-docs/iam/oauthprovider/)。
- docs.volcengine.com 拒绝连接（ECONNREFUSED），文档全文读不到。
- 可信度 medium：这是"找不到证据"得出的结论。

## 4）钉钉、企业微信跨组织登录要不要服务商资质

**钉钉：要 ISV，门槛对新公司基本做不到。** 和调研代理**一致**，high。
- 原文："企业内部应用仅支持本组织员工登录"，"内部应用不支持跨组织授权登录"。来源：[网页方式登录](https://open.dingtalk.com/document/development/tutorial-obtaining-user-personal-information)。
- FAQ："我想做 SaaS 产品，但不想走审核流程行不行？不行……只能作为'内部应用'通过'代开发'模式由客户手动安装"。第三方个人应用只支持小程序，不支持网页应用。来源：[应用类型](https://open.dingtalk.com/document/dingstart/application-type-introduction)。
- 上架准入（2025-04 生效）："钉钉指数分≥1000分"、"至少3家客户的深度共创"、"完成鸿蒙系统适配"；上架市场还要"近6个月付费客户数≥10且GMV≥10万"（或≥3 家且≥50 万）。来源：[合作全流程指引](https://open.dingtalk.com/document/services/isv-cooperation-guide)。
- 企业认证 1~3 天，入驻审核 1-2 个工作日。来源：[成为服务商](https://open.dingtalk.com/document/services/become-an-application-service-provider)。

**企业微信：要以企业身份注册服务商，但不用对方企业先安装。** 和调研代理**一致**。
- 服务商登录接口 getuserinfo3rd：没有授权关系时"返回密文UserId"；"若用户不属于任何企业"返回"对当前服务商唯一"的 openid。来源：[获取登录用户身份](https://developer.work.weixin.qq.com/document/path/98179)，high。
- login_type=ServiceApp 只给服务商用，非服务商报 -31039 或 -31034；回调"必须配置为可信域名"。来源：[Web 登录组件](https://developer.work.weixin.qq.com/document/path/98152)，high。
- 注册条件："拥有一个企业微信；用系统管理员身份……申请"；"服务商必须经过认证"才能上线第三方应用。来源：[服务商注册](https://developer.work.weixin.qq.com/document/path/90595)，high。
- 只开登录授权要不要先认证，[开始开发](https://developer.work.weixin.qq.com/document/path/98170)只列了"配置登录授权"和"品牌名称"两步，没写，low。
- 可信域名要"备案主体与企业认证主体相同或有关联"，这条规矩在官方社区里能看到，但讲的是自建应用场景；服务商登录域名是否同样要求，没核实，medium。

## 5）QQ 互联、支付宝、抖音、微博、Gitee 的门槛

| 平台 | 核实结论 | 和调研代理 | 出处 | 可信度 |
|---|---|---|---|---|
| QQ 互联 | 个人、公司都能注册（"提交公司或个人的基本资料"），一个营业执照或身份证只能认证一个 QQ 号。网站要 ICP 备案，"在QQ互联平台填写的备案信息需与工信部保持一致"，没要求备案主体和开发者一致。审核规范写 1-3 个工作日，FAQ 写"大约5个工作日"。没过审只能用开发者 QQ 测试。免费。 | 一致（审核时长要补上 1-3 天这个说法） | [成为开发者](https://wiki.connect.qq.com/成为开发者)、[应用审核规范](https://wiki.connect.qq.com/网站审核规范)、[申请注册相关](https://wiki.connect.qq.com/常规问题-20170322) | high |
| 抖音 | 网站应用只对企业身份开放（企业、个体户等）；个人只能建小程序、小游戏、小玩法。"企业认证无需认证费用"。上线转正要"ICP备案主体需与开发者主体一致，或与开发者主体为总分公司关系"，平台 2 个工作日内审核。 | 一致 | [入驻 FAQ](https://developer.open-douyin.com/docs/resource/zh-CN/developer/join/issues)、[应用上线](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/app-mgmt/pub-app) | high |
| 微博 | 要邮箱和手机验证；"开发者类型一经填写，不可修改"；"个人开发者不可接入微博支付业务"，可见个人能做登录。审核要"网站具有ICP备案号"。**文档最后更新是 2014 年**。 | 一致（要加上"文档很旧"） | [新手指南](https://open.weibo.com/wiki/新手指南)、[网站接入](https://open.weibo.com/wiki/网站接入介绍) | medium |
| 支付宝 | 搜索摘要显示官方能力页"获取会员信息""APP支付宝登录"的账号类型是企业、个体工商户、个人。页面是 JS 渲染，用 curl 和 headless 浏览器都没取到正文。 | 一致（同样没拿到原文） | [获取会员信息](https://open.alipay.com/api/detail?abilityCode=AM010501000000101377) | low-medium |
| Gitee | 个人在"设置→第三方应用"就能建，标准授权码流程。gitee.com 从 原讨论服务器 连接超时，只能依据搜索摘要和教程。 | 一致 | [OAuth 文档](https://gitee.com/api/v5/oauth_doc) | medium |

## 6）Google、GitHub 在大陆的可用性有没有可靠出处

**Google：大陆被封，有两个独立来源互相印证。** 和调研代理**一致**，high。
- GreatFire：
  - [accounts.google.com](https://en.greatfire.org/https/accounts.google.com) 近 90 天 8 次有效测试 8 次受干扰，最近一次 2026-11-02，从 2012 年起一直有记录；
  - [www.google.com](https://en.greatfire.org/https/www.google.com) 判为 blocked，18 次里 17 次被封（最近 2026-11-06）；
  - [oauth2.googleapis.com](https://en.greatfire.org/https/oauth2.googleapis.com) 只有 1 次测试，判 blocked，样本太少。
- OONI（api.ooni.io 的 aggregation 接口，probe_cc=CN，web_connectivity）：
  - accounts.google.com 2026-08-13 到 11-13 共 18 次测量，**18 次异常、0 次正常**；
  - www.googleapis.com 半年 331 次只有 9 次正常；
  - www.google.com 半年 425 次只有 10 次正常。
- 腾讯云大陆机房出站去 Google 换 token、取 JWKS 能不能通，没有实测，属推断，medium。

**GitHub：能打开但不稳。** 和调研代理**一致**，medium-high。
- GreatFire：[github.com/login](https://en.greatfire.org/https/github.com/login) 判"unreliable"，3 次测试 3 次受干扰（最近 2026-11-02），2022-12 起有记录。
- OONI：github.com 近 90 天 398 次测量，正常 205、异常 159、失败 34，正常率约 52%；api.github.com 139 次里 136 次正常。OONI 的"异常"不等于确认封锁，但两个来源方向一致。
- GitHub 官方文档原文（[授权 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)，high）：
  - 网页流程换 token 时 client_secret 是 "Required"；
  - PKCE "Must be S256"；
  - 回环地址可以用任意端口；
  - 设备码"50 submissions in an hour per application"，而且要先在应用设置里打开。
- Google 官方（[原生应用](https://developers.google.com/identity/protocols/oauth2/native-app)，high）：
  - 桌面推荐回环地址；
  - "Custom URI schemes are no longer supported"；
  - OOB 已停用；
  - 内嵌浏览器报 disallowed_useragent。

---

## 推荐的第一批登录方式（owner 有公司、没有飞书 ISV）

**先做一件横向的事：** 把 vonvon.cc 的 ICP 备案主体改到公司名下，或者另备一个公司备案的域名放账号服务。理由有三条：
- 微信审核规范要求官网和登记表的主体与认证主体一致；
- 抖音要求备案主体和开发者主体一致；
- 腾讯云写明个人备案"不能涉及企业"。

**统一做法：** 所有第三方登录都在 vonvon.cc 服务端回调，secret 只放服务端。桌面端用系统浏览器 + PKCE，结果经回环地址、deep link 或轮询交回 App。Linux 命令行用 vonvon 自己的设备码页面，不直接用各家的设备码。

1. **微信（开放平台网站应用扫码登录）**
   - 理由：大陆覆盖最大，大陆直连；电脑上开着微信时可以免扫码快速登录。
   - 手续：
     - 公司注册开放平台，做开发者资质认证（300 元/次，要不要年审以后台为准）；
     - 创建网站应用并过审（官网要有服务说明、用户协议、备案信息、联系方式，主体和认证主体一致）；
     - 申请微信登录权限，等审核；
     - 配授权回调域 vonvon.cc（最多 1 个，每月最多改 5 次）。
   - 以后要手机号时，再在同一开放平台下开一个公司主体、已认证的小程序，用手机号快速验证（0.03 元/次）。
2. **GitHub**
   - 理由：开发者和 AI 用户里覆盖最高；免费、不审核，建好就能用。
   - 手续：在一个 GitHub 组织下建 OAuth App，回调到 vonvon.cc。
   - 要注意：大陆用户侧不稳，服务端换 token 要加重试，或走境外出口。
3. **QQ 互联**
   - 理由：国内第二个覆盖面大、免费、个人或公司都能申请的方式；有 QQ 快速登录和扫码；回调不要求和备案主体一致。
   - 手续：用公司公共 QQ 号注册开发者（交营业执照），创建网站应用（填域名、回调地址和与工信部一致的备案号），审核 1-5 个工作日。
4. **Google**
   - 理由：owner 点名要；免费、不审核（只用 openid、email、profile）。但大陆被封，用户要科学上网，服务端也要境外出口。
   - 手续：建 Google Cloud 项目，配 OAuth 客户端（Web 类型）并发布为 Production；要显示品牌名和 logo，就用 Search Console 验证 vonvon.cc 并做品牌验证（自动审核几分钟，人工 2-3 个工作日）。
   - 登录页上标注"需要能访问 Google"。
5. **Apple（可选，成本最低）**
   - 理由：owner 已有 Apple 开发者会员，Mac 用户基本都有 Apple ID；GreatFire 显示大陆可直连，但样本少，medium。
   - 手续：在开发者后台配 Services ID 和回调地址（回调要落在 https 域名上），生成 .p8 密钥签 client_secret（最长 6 个月，要轮换）。
6. **飞书：这一版只做"绑定"，不当登录方式**
   - 理由：没有 ISV 就不能跨租户 OAuth。
   - 手续：用户已有的 bot 应用走设备码拿 user_access_token，服务端调 user_info，按 (tenant_key, union_id) 绑定（推断方案，low）；或者在 vonvon 自己的租户开一个"对外共享"机器人，私聊确认绑定 open_id（要企业认证或个人实名，原文 high）。
   - 两种都不能防刷。

**暂不做：**
- 抖音（要先改好备案主体，用户意愿一般，放第二批）；
- 企业微信服务商（要公司注册服务商，域名多半也要求主体一致，放第二批）；
- 微博、百度、Gitee（门槛低，但覆盖低，按需再加）；
- 钉钉（ISV 门槛做不到）；
- 飞书商店应用（ISV 做不到）；
- 火山引擎（没有对外的登录能力）。
