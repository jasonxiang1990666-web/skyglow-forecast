# 观赏时段反馈与 AI 自动审核

## 功能范围

详情页只有在当前时间位于朝霞或晚霞的建议观赏窗口内时，才会显示反馈卡片。用户可选择 0–4 分、现场标签和一句补充说明。提交时会尝试读取当前位置；用户拒绝定位也可以提交，但可信度会降低。

## 数据流

1. 小程序调用 `skyFeedback` 云函数，不直接写数据库。
2. 云函数校验城市、霞况类型、时段、分数和反馈内容，并限制同一用户同一时段只能提交一次。
3. AI 初筛会综合提交时间、定位网格、补充信息完整度和同一时段已有通过样本的一致性，生成 `trustScore` 与 `reviewStatus`。
4. 原始反馈只写入 `skyFeedback`，不会直接写入 `skyObservations`，也不会未经审核改变概率。后续可按批次将 `auto_approved` 样本汇总后再进入历史校准。

## 数据库配置

在云开发数据库创建集合 `skyFeedback`，权限选择“仅管理员可读写”。集合中不保存明文 OpenID，只保存不可逆的 `openidHash` 和两位小数的 `locationGrid`，减少隐私风险。建议为 `eventKey`、`openidHash` 建立索引；如果暂时不建索引，小规模测试也可以正常运行。

主要字段：

- `eventKey`：城市、类型和观赏窗口组成的唯一事件键。
- `city`、`type`、`targetAt`、`startAt`、`endAt`：反馈对应的预报窗口。
- `observedScore`：用户实际感受，0–4 分。
- `tags`、`note`：现场补充信息。
- `reviewStatus`：`provisional`（样本积累中）、`auto_approved`（AI 初筛通过）或 `rejected`（暂不纳入校准）。
- `trustScore`、`reviewReasons`、`consensusCount`、`consensusAverage`：AI 审核依据，便于后续分析。
- `modelVersion`：当前为 `feedback-ai-v1`。

## 部署

在微信开发者工具中右键上传 `cloudfunctions/skyFeedback`，云端安装依赖后部署。部署完成后再真机调试，在建议观赏时段内进入详情页提交一条反馈；控制台数据库中应出现一条 `skyFeedback` 记录。

AI 审核是自动化的质量筛选，不等于证明现场事实。当前版本通过“时间窗口 + 可选定位 + 多人一致性”降低误报，后续可继续加入天气实况、设备行为和异常频率等信号。
