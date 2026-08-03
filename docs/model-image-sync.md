# 上海 EC / GFS 云量图自动生成

## 目标

每次任务运行时，`modelImageSync` 会：

1. 用上海经纬度计算下一次日出与日落；
2. 从 `modelSnapshots` 找出 EC、GFS 在目标时间前后 6 小时内最接近的上海快照；
3. 请求云托管 `model-image-renderer` 生成 4 张总云量 PNG；
4. 上传至云存储，并将 `imageFileId`、图片实际有效时间等字段回写到对应快照。

现有霞况详情页已会把 `imageFileId` 转为临时图片地址，因此不需要再改小程序页面；图片生成成功后，重新进入详情页即可展示。

## 前置条件

- `modelSync` 已至少为上海同步 EC 与 GFS 的近期数值快照；
- `modelSnapshots` 允许云函数读写；
- 已按 [云托管渲染服务说明](../services/model-image-renderer/README.md) 部署 `model-image-renderer`；
- 已在 `modelImageSync` 配置 `MODEL_IMAGE_RENDERER_URL`，如使用令牌，还需配置 `MODEL_IMAGE_RENDERER_TOKEN`；
- `modelImageSync` 超时设置为 60 秒、内存设置为 512 MB。

## 手动验证

先运行：

```json
{ "dryRun": true }
```

预期返回 `EC × 朝霞、EC × 晚霞、GFS × 朝霞、GFS × 晚霞` 的候选任务；若某个任务缺少附近快照，会出现在 `unavailable`。

随后运行：

```json
{}
```

成功项会返回 `imageFileId`。在 `modelSnapshots` 中可看到以下字段：

- `imageFileId`
- `imageStatus: "ready"`
- `imageGeneratedAt`
- `imageTargetAt`
- `imageValidAt`
- `imageProvider`

定时器为每天 `05:00、11:00、17:00、23:00`（中国时区）；它安排在数值同步后约半小时运行。若要改为更密集更新，先确认云托管的外网流量与 ECMWF/GFS 数据源限制。
