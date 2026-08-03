# 精选观赏点维护说明

精选观赏点保存在云开发数据库集合 `viewingSpots` 中。小程序只通过云函数读取 `status` 为 `published` 的记录，因此可以先以 `draft` 状态保存，核验后再公开。

## 建议字段

```json
{
  "cityKey": "上海",
  "city": "上海",
  "district": "黄浦区",
  "name": "观赏点名称",
  "address": "具体地址或附近地标",
  "latitude": 31.2304,
  "longitude": 121.4737,
  "type": "江边观景平台",
  "scenes": ["sunset", "fireCloud"],
  "viewDirections": ["west", "southwest"],
  "openness": 5,
  "tips": "西侧视野较开阔，建议日落前十五分钟抵达。",
  "safetyNotice": "夜间请留意临水护栏和返程安全。",
  "verifiedAt": "2026-07-28",
  "status": "draft"
}
```

## 字段取值

- `scenes`：`sunrise`（朝霞）、`sunset`（晚霞）、`fireCloud`（火烧云），可同时填写多个。
- `viewDirections`：`east`、`southeast`、`south`、`southwest`、`west`、`northwest`。
- `openness`：1 到 5，5 代表地平线与天空遮挡较少。
- `status`：`draft` 为待核验，`published` 为公开展示，`offline` 为下架。

## 维护流程

1. 在云开发控制台的数据库中新建集合 `viewingSpots`。
2. 添加记录时先使用 `draft`，核对地图坐标、开放状态、视野和安全提示。
3. 核验完成后将记录的 `status` 改为 `published`；用户端刷新后即可显示。
4. 发现闭园、施工或有安全风险时，将 `status` 改为 `offline`。

建议数据库权限设置为“仅管理员可读写”，因为用户端通过云函数读取公开记录，无需开放数据库直连权限。
