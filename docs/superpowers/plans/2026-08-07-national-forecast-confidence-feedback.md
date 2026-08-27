# National Forecast Confidence and Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为全国城市增加可解释的预报可信度、观赏时段反馈、AI 自动审核、城市近 30 天准确率和小幅有界校准，同时保证任何新服务异常都不阻塞核心霞况预报。

**Architecture:** `forecast` 云函数继续负责天气与 EC/GFS 融合，并新增稳定 `forecastId`、可信度和权威预报快照；`skyFeedback` 负责匿名反馈、规则审核、冷启动共识与标准观测写入；新的 `cityAccuracy` 云函数负责滚动统计查询和定时聚合。小程序首页只显示紧凑可信度，详情页展示解释与反馈入口，城市准确率使用独立页面。

**Tech Stack:** 微信小程序原生 WXML/WXSS/JavaScript、腾讯云 CloudBase 云函数与文档数据库、Node.js 内置 `node:test`、现有 `wx-server-sdk`。

## Global Constraints

- 全国统计主键必须使用 `cityCode + sceneType + observationDate + windowStart`，不得只使用中文城市名。
- 精确经纬度不得写入反馈和统计集合；仅保存约 1 公里粒度的 `locationGrid`。
- 首页天气与霞况预报是关键路径；记录持久化、反馈、审核、统计任何失败都只能降级，不能使 `forecast` 请求失败。
- `probability` 是本次模型估算出现概率，`accuracyRate` 是历史命中率，两者字段和文案不得混用。
- 样本少于 30 条时不展示准确率百分比，只展示积累进度。
- 新逻辑必须兼容已有缺字段记录与旧版 `observedScore` 反馈。
- 每个任务严格按测试先行步骤执行；不要把多个任务积攒到一次提交。

---

## Task 1: 建立可信度纯规则模块和测试基础

**Files:**
- Create: `cloudfunctions/forecast/confidence.js`
- Create: `cloudfunctions/forecast/test/confidence.test.js`
- Modify: `cloudfunctions/forecast/package.json`

- [ ] **Step 1: 写失败测试，固定新鲜度、完整度和 EC/GFS 一致性边界**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateForecastConfidence } = require('../confidence')

test('fresh complete consistent data is high confidence', () => {
  const now = Date.parse('2026-08-07T12:00:00+08:00')
  const result = evaluateForecastConfidence({
    now,
    weatherUpdatedAt: now - 60 * 60 * 1000,
    requiredWeatherFields: [20, 40, 60],
    ec: { status: 'ready', validAt: now, totalCloud: 52, precipitation: 0 },
    gfs: { status: 'ready', validAt: now, totalCloud: 63, precipitation: 0 }
  })
  assert.equal(result.level, 'high')
  assert.equal(result.modelAgreement, 'consistent')
})

test('cloud difference over 30 or rain conflict is low confidence', () => {
  const result = evaluateForecastConfidence({
    now: 1000,
    weatherUpdatedAt: 1000,
    requiredWeatherFields: [1],
    ec: { status: 'ready', totalCloud: 10, precipitation: 0 },
    gfs: { status: 'ready', totalCloud: 70, precipitation: 1 }
  })
  assert.equal(result.level, 'low')
  assert.equal(result.modelAgreement, 'conflict')
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/forecast/test/confidence.test.js`

Expected: FAIL，提示找不到 `../confidence`。

- [ ] **Step 3: 实现最小纯函数**

接口固定为：

```js
function evaluateForecastConfidence(input) {
  return {
    level: 'high',              // high | medium | low
    label: '高可信度',
    reasons: [],
    freshness: 'fresh',         // fresh | normal | stale
    completeness: 'complete',   // complete | partial
    modelAgreement: 'consistent', // consistent | different | conflict | unavailable
    weatherAgeHours: 0,
    ecStatus: 'ready',
    gfsStatus: 'ready'
  }
}
```

规则必须严格实现：天气数据 `<=3h` 为 fresh、`3–6h` 为 normal、`>6h` 为 stale；云量差 `<=15` 且降水趋势相同为 consistent，`15–30` 为 different，`>30` 或降水有无冲突为 conflict；fresh + complete + consistent 才能 high，一个一般问题为 medium，陈旧、关键字段缺失或模型冲突为 low。

- [ ] **Step 4: 补齐边界测试**

增加恰好 3h、6h、15%、30%，单模型缺失、天气字段缺失和两个模型都缺失的测试。

- [ ] **Step 5: 运行测试并确认通过**

Run: `node --test cloudfunctions/forecast/test/confidence.test.js`

Expected: PASS，全部可信度规则测试通过。

- [ ] **Step 6: 增加测试脚本并提交**

在 `cloudfunctions/forecast/package.json` 增加：

```json
"scripts": { "test": "node --test test" }
```

Run: `git add cloudfunctions/forecast/confidence.js cloudfunctions/forecast/test/confidence.test.js cloudfunctions/forecast/package.json`

Run: `git commit -m "test: define forecast confidence rules"`

---

## Task 2: 生成全国稳定 forecastId 和权威预报记录

**Files:**
- Create: `cloudfunctions/forecast/forecast-record.js`
- Create: `cloudfunctions/forecast/test/forecast-record.test.js`
- Modify: `cloudfunctions/forecast/qweather.js`
- Modify: `cloudfunctions/forecast/index.js`

- [ ] **Step 1: 写 forecastId 和位置网格失败测试**

```js
const { buildForecastId, locationGrid } = require('../forecast-record')

assert.equal(
  buildForecastId({ cityCode: '101020100', sceneType: 'sunset', observationDate: '2026-08-07', windowStart: 1786100000000, algorithmVersion: '2.0' }),
  '101020100|sunset|2026-08-07|1786100000000|2.0'
)
assert.equal(locationGrid(31.2304, 121.4737), '31.23,121.47')
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/forecast/test/forecast-record.test.js`

Expected: FAIL，提示找不到 `../forecast-record`。

- [ ] **Step 3: 实现预报记录构建接口**

```js
function enrichForecastWindows({ forecast, location, coordinates, confidenceByKind }) {}
async function persistForecastRecords(db, records) {}
module.exports = { buildForecastId, locationGrid, enrichForecastWindows, persistForecastRecords }
```

每个 `skyWindow` 生成两条权威记录：主霞况 `sunrise`/`sunset` 和 `fireCloud`。记录包含 spec 第 4.1 节全部字段，并把 `forecastId` 与 `forecastConfidence` 同时回填到页面返回结构。`persistForecastRecords` 使用 `forecastId` 幂等更新 `forecastRecords`，写入失败仅 `console.warn`。

- [ ] **Step 4: 让和风天气适配器返回数据更新时间**

把 `getWeather()` 返回值改为：

```js
return {
  hourly: hourly.hourly || [],
  daily: daily.daily || [],
  weatherUpdatedAt: Date.parse(hourly.updateTime || daily.updateTime || new Date().toISOString())
}
```

并保留调用方对旧 `{ hourly, daily }` 的兼容。

- [ ] **Step 5: 在 forecast 主流程接入但不阻塞核心返回**

在 `buildForecastView()` 后执行：

```js
const enriched = enrichForecastWindows({ forecast: view, location, coordinates, confidenceByKind })
await persistForecastRecords(db, enriched.records).catch((error) => console.warn('forecast record persistence failed', error))
return enriched.forecast
```

`cityCode` 使用和风天气 `location.id`；`cityName` 使用现有 `resolvedCity`；`districtName` 使用反向地理编码结果；无 GPS 时 `locationGrid` 为空字符串。

- [ ] **Step 6: 测试幂等键、两个场景和旧数据降级**

测试同一次刷新 ID 不变、算法版本变化 ID 变化、缺少区县或坐标不抛错、主霞况与火烧云记录各自有唯一 ID。

- [ ] **Step 7: 运行 forecast 测试并提交**

Run: `npm test --prefix cloudfunctions/forecast`

Expected: PASS。

Run: `git add cloudfunctions/forecast`

Run: `git commit -m "feat: persist nationwide forecast identities"`

---

## Task 3: 在首页展示紧凑可信度信息

**Files:**
- Create: `miniprogram/utils/forecast-confidence.js`
- Create: `miniprogram/test/forecast-confidence.test.js`
- Modify: `miniprogram/pages/index/index.js`
- Modify: `miniprogram/pages/index/index.wxml`
- Modify: `miniprogram/pages/index/index.wxss`

- [ ] **Step 1: 写页面映射失败测试**

```js
const { confidencePresentation } = require('../utils/forecast-confidence')
assert.deepEqual(confidencePresentation({ level: 'high', modelAgreement: 'consistent' }), {
  label: '高可信度', tone: 'high', summary: 'EC/GFS 较一致'
})
assert.equal(confidencePresentation(null).label, '可信度待同步')
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test miniprogram/test/forecast-confidence.test.js`

Expected: FAIL，提示缺少工具模块。

- [ ] **Step 3: 实现映射并在加载完成时生成页面字段**

首页 `loadForecast()` 成功后，把 `primaryWindow.forecastConfidence` 映射为 `confidenceView`。页面主霞况卡底部增加单行：

```xml
<view class="confidence-strip confidence-{{confidenceView.tone}}">
  <text>{{confidenceView.label}}</text>
  <text>{{confidenceView.summary}}</text>
  <text>{{forecast.updatedAt}}</text>
</view>
```

首页不得展示城市准确率百分比，也不得增加新的阻塞加载状态。

- [ ] **Step 4: 测试 high/medium/low/null 四种映射**

Run: `node --test miniprogram/test/forecast-confidence.test.js`

Expected: PASS。

- [ ] **Step 5: 在开发者工具检查首页**

验证高/中/低三种颜色仅作轻量背景和文字提示；天气加载成功但可信度缺失时显示“可信度待同步”，卡片仍可点击。

- [ ] **Step 6: 提交首页可信度 UI**

Run: `git add miniprogram/utils/forecast-confidence.js miniprogram/test/forecast-confidence.test.js miniprogram/pages/index`

Run: `git commit -m "feat: show compact forecast confidence"`

---

## Task 4: 在详情页展示可信度解释并绑定 forecastId

**Files:**
- Modify: `miniprogram/pages/sky-detail/sky-detail.js`
- Modify: `miniprogram/pages/sky-detail/sky-detail.wxml`
- Modify: `miniprogram/pages/sky-detail/sky-detail.wxss`
- Modify: `miniprogram/services/weather.js`

- [ ] **Step 1: 写详情字段归一化失败测试**

在 `miniprogram/test/forecast-confidence.test.js` 增加 `confidenceDetails()` 测试，固定 `reasons` 非数组、旧记录缺 `forecastId`、模型不可用时的降级输出。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test miniprogram/test/forecast-confidence.test.js`

Expected: FAIL，提示 `confidenceDetails` 未实现。

- [ ] **Step 3: 实现详情可信度卡**

详情页在霞况结论后显示：等级、数据更新时间、EC/GFS 一致性和最多 3 条原因。若字段缺失，显示“当前仅提供基础霞况预报”，不能显示空白占位或抛异常。

- [ ] **Step 4: 让反馈 payload 绑定权威标识**

`submitSkyFeedback()` payload 增加：

```js
{
  forecastId: selected.forecastId,
  cityCode: selected.cityCode,
  sceneType: skyWindow.kind,
  windowStart: skyWindow.startAt,
  windowEnd: skyWindow.endAt
}
```

火烧云反馈仍与同一个窗口一起提交，不从客户端信任任何预测评分。

- [ ] **Step 5: 运行测试并在开发者工具验证降级**

Run: `node --test miniprogram/test/forecast-confidence.test.js`

Expected: PASS。手动删除模拟返回中的 `forecastConfidence` 后详情仍正常打开。

- [ ] **Step 6: 提交详情可信度**

Run: `git add miniprogram/pages/sky-detail miniprogram/services/weather.js miniprogram/utils/forecast-confidence.js miniprogram/test/forecast-confidence.test.js`

Run: `git commit -m "feat: explain confidence in sky detail"`

---

## Task 5: 将反馈表单升级为全国统一结构

**Files:**
- Create: `cloudfunctions/skyFeedback/review.js`
- Create: `cloudfunctions/skyFeedback/test/review.test.js`
- Modify: `cloudfunctions/skyFeedback/index.js`
- Modify: `cloudfunctions/skyFeedback/package.json`
- Modify: `miniprogram/pages/sky-detail/sky-detail.js`
- Modify: `miniprogram/pages/sky-detail/sky-detail.wxml`
- Modify: `miniprogram/pages/sky-detail/sky-detail.wxss`

- [ ] **Step 1: 写结构校验和审核分数失败测试**

覆盖：窗口外拒绝、无 `forecastId` 拒绝、seen/color/cloud/visibility 非法值拒绝、note 截断到 60 字、有效坐标被转换为两位小数网格、无坐标降权但不拒绝。

```js
const { validateFeedback, evaluateSubmission } = require('../review')
assert.equal(validateFeedback(validInput).note.length <= 60, true)
assert.equal(evaluateSubmission({
  inWindow: true,
  locationScore: 1,
  frequencyScore: 1,
  completenessScore: 1,
  consensusDelta: null,
  consensusCount: 0
}).status, 'provisional')
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/skyFeedback/test/review.test.js`

Expected: FAIL，提示缺少 `../review`。

- [ ] **Step 3: 实现纯审核模块**

```js
function validateFeedback(event) {}
function buildLocationGrid(latitude, longitude) {}
function evaluateSubmission({ inWindow, locationScore, frequencyScore, completenessScore, consensusDelta, consensusCount }) {}
function normalizeObservations({ feedback, forecastRecord }) {}
module.exports = { validateFeedback, buildLocationGrid, evaluateSubmission, normalizeObservations }
```

统一字段：`seenLevel` 0–3、`colorIntensity` 0–3、`cloudCondition` 枚举、`visibilityLevel` 枚举、标签最多 5 个、note 最多 60 字。临时兼容旧 `observedScore`，但存储时转换到新 schema。

- [ ] **Step 4: 详情表单改为四组简洁选项**

仅在真实观赏时段显示：看到了什么、霞色强度、云层情况、能见度，外加标签和 60 字备注。提交按钮沿用现有 loading/成功/失败状态。

- [ ] **Step 5: 增加 package 测试脚本并跑通**

`cloudfunctions/skyFeedback/package.json` 增加 `"test": "node --test test"`。

Run: `npm test --prefix cloudfunctions/skyFeedback`

Expected: PASS。

- [ ] **Step 6: 提交反馈 schema**

Run: `git add cloudfunctions/skyFeedback miniprogram/pages/sky-detail`

Run: `git commit -m "feat: standardize nationwide sky feedback"`

---

## Task 6: 修复 AI 审核冷启动并写入标准观测

**Files:**
- Create: `cloudfunctions/skyFeedback/consensus.js`
- Create: `cloudfunctions/skyFeedback/test/consensus.test.js`
- Modify: `cloudfunctions/skyFeedback/index.js`

- [ ] **Step 1: 写冷启动死锁回归测试**

```js
const { buildConsensus, promotableFeedbackIds } = require('../consensus')

test('three high-trust provisional users can form first consensus', () => {
  const rows = [
    { _id: 'a', anonymousUserHash: 'u1', reviewStatus: 'provisional', reviewScore: 82, seenLevel: 2 },
    { _id: 'b', anonymousUserHash: 'u2', reviewStatus: 'provisional', reviewScore: 80, seenLevel: 2 },
    { _id: 'c', anonymousUserHash: 'u3', reviewStatus: 'provisional', reviewScore: 85, seenLevel: 3 }
  ]
  assert.deepEqual(promotableFeedbackIds(rows).sort(), ['a', 'b', 'c'])
})
```

- [ ] **Step 2: 运行测试并确认现有逻辑失败**

Run: `node --test cloudfunctions/skyFeedback/test/consensus.test.js`

Expected: FAIL；现有 `getConsensus()` 只读取 `auto_approved`，无法形成首批共识。

- [ ] **Step 3: 实现候选共识规则**

候选集合必须包含：`auto_approved`，以及 `provisional && reviewScore >= 75`；按不同 `anonymousUserHash` 去重；至少 3 位用户、核心观测值差异不超过 1 档时，整批晋升。低信任 provisional 不参与共识，rejected 永不参与。

- [ ] **Step 4: 实现幂等晋升和 skyObservations 写入**

提交后调用：

```js
await promoteConsensusBatch({ db, eventKey, forecastRecord })
```

对晋升记录更新 `reviewStatus: 'auto_approved'`、`reviewedAt`；按 `feedbackId + sceneType` 幂等 upsert 到 `skyObservations`。一次窗口反馈标准化为主霞况观测和 fireCloud 观测，预测分数必须来自 `forecastRecords`，不能来自客户端。

- [ ] **Step 5: 测试重复调用、重复用户和分歧样本**

确保重复晋升不产生重复标准观测；同一用户多条只算一票；3 条相差 2 档不能晋升；已有 approved + 新 provisional 可以形成共识。

- [ ] **Step 6: 运行测试并提交**

Run: `npm test --prefix cloudfunctions/skyFeedback`

Expected: PASS。

Run: `git add cloudfunctions/skyFeedback`

Run: `git commit -m "fix: unlock cold-start feedback consensus"`

---

## Task 7: 增加频率限制、失败重试和旧数据兼容

**Files:**
- Modify: `cloudfunctions/skyFeedback/index.js`
- Modify: `cloudfunctions/skyFeedback/review.js`
- Modify: `cloudfunctions/skyFeedback/test/review.test.js`
- Create: `miniprogram/utils/feedback-retry.js`
- Create: `miniprogram/test/feedback-retry.test.js`
- Modify: `miniprogram/pages/sky-detail/sky-detail.js`

- [ ] **Step 1: 写限频和重试队列失败测试**

覆盖同一用户同一 `forecastId` 只能提交一次、短时间跨城市大量提交降权、失败 payload 只保存在本机且成功后删除、旧版 observedScore 可读取。

- [ ] **Step 2: 实现服务端限频与客户端单条重试队列**

本地键固定为 `pendingSkyFeedback`，只保留最近一次失败的结构化反馈，不存经纬度。详情页下次 `onShow` 时仅在仍处于对应窗口内重试一次。

- [ ] **Step 3: 运行两侧测试**

Run: `npm test --prefix cloudfunctions/skyFeedback`

Run: `node --test miniprogram/test/feedback-retry.test.js`

Expected: 全部 PASS。

- [ ] **Step 4: 提交可靠性改动**

Run: `git add cloudfunctions/skyFeedback miniprogram/utils/feedback-retry.js miniprogram/test/feedback-retry.test.js miniprogram/pages/sky-detail/sky-detail.js`

Run: `git commit -m "feat: harden feedback submission reliability"`

---

## Task 8: 实现城市近 30 天准确率聚合云函数

**Files:**
- Create: `cloudfunctions/cityAccuracy/index.js`
- Create: `cloudfunctions/cityAccuracy/metrics.js`
- Create: `cloudfunctions/cityAccuracy/test/metrics.test.js`
- Create: `cloudfunctions/cityAccuracy/package.json`
- Create: `cloudfunctions/cityAccuracy/config.json`

- [ ] **Step 1: 写四档命中规则失败测试**

```js
const { scoreBin, observationBin, isHit, aggregateAccuracy } = require('../metrics')
assert.equal(scoreBin(39), 0)
assert.equal(scoreBin(40), 1)
assert.equal(scoreBin(70), 2)
assert.equal(scoreBin(80), 3)
assert.equal(isHit(1, 2), true)
assert.equal(isHit(0, 2), false)
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/cityAccuracy/test/metrics.test.js`

Expected: FAIL，缺少 metrics 模块。

- [ ] **Step 3: 实现 30 天滚动聚合**

`aggregateAccuracy(observations, now)` 分别生成 sunrise、sunset、fireCloud：`sampleCount`、`hitCount`、`accuracyRate`、`windowDays: 30`、`status: collecting|ready`。少于 30 条时 `accuracyRate` 必须为 `null`。

- [ ] **Step 4: 实现云函数两个 action**

```js
// action: aggregate
await aggregateAllActiveCities(db)

// action: getCityAccuracy
return getCityAccuracy(db, event.cityCode)
```

定时聚合按 `cityCode` 分页读取近 30 天 `skyObservations`，幂等写入 `accuracyStats`。查询失败返回 collecting 降级结构，不抛给小程序。

- [ ] **Step 5: 配置每天凌晨聚合触发器**

`config.json` 使用每日北京时间 02:20 对应的 CloudBase cron，并在部署时核实控制台显示的时区。不要高频扫描全库。

- [ ] **Step 6: 测试 29/30 条边界、三种 scene 和空城市**

Run: `node --test cloudfunctions/cityAccuracy/test/metrics.test.js`

Expected: PASS。

- [ ] **Step 7: 提交聚合云函数**

Run: `git add cloudfunctions/cityAccuracy`

Run: `git commit -m "feat: aggregate city forecast accuracy"`

---

## Task 9: 新增城市准确率页面

**Files:**
- Create: `miniprogram/pages/city-accuracy/city-accuracy.js`
- Create: `miniprogram/pages/city-accuracy/city-accuracy.json`
- Create: `miniprogram/pages/city-accuracy/city-accuracy.wxml`
- Create: `miniprogram/pages/city-accuracy/city-accuracy.wxss`
- Create: `miniprogram/utils/accuracy.js`
- Create: `miniprogram/test/accuracy.test.js`
- Modify: `miniprogram/services/weather.js`
- Modify: `miniprogram/pages/sky-detail/sky-detail.js`
- Modify: `miniprogram/pages/sky-detail/sky-detail.wxml`
- Modify: `miniprogram/app.json`

- [ ] **Step 1: 写准确率展示映射失败测试**

测试 `sampleCount: 29` 显示“已积累 29/30 条”，不包含 `%`；`sampleCount: 30, accuracyRate: 0.8` 显示“80%”；缺字段返回“数据积累中”。

- [ ] **Step 2: 实现服务调用和独立页面**

`getCityAccuracy(cityCode)` 调用 `cityAccuracy` 云函数。页面展示城市名、近 30 天说明，以及朝霞、晚霞、火烧云三张统计卡；不增加全国排行榜。

- [ ] **Step 3: 从详情可信度卡进入准确率页**

仅当详情有 `cityCode` 时显示“查看本城市预报表现”；首页不展示百分比。路径：

```js
wx.navigateTo({ url: `/pages/city-accuracy/city-accuracy?cityCode=${encodeURIComponent(cityCode)}&cityName=${encodeURIComponent(cityName)}` })
```

- [ ] **Step 4: 运行测试并做页面状态验证**

Run: `node --test miniprogram/test/accuracy.test.js`

Expected: PASS。开发者工具分别验证 loading、collecting、ready、error 四种状态。

- [ ] **Step 5: 提交准确率页面**

Run: `git add miniprogram/pages/city-accuracy miniprogram/utils/accuracy.js miniprogram/test/accuracy.test.js miniprogram/services/weather.js miniprogram/pages/sky-detail miniprogram/app.json`

Run: `git commit -m "feat: add city forecast accuracy page"`

---

## Task 10: 将有界城市校准接入概率模型

**Files:**
- Modify: `cloudfunctions/forecast/calibration.js`
- Create: `cloudfunctions/forecast/test/calibration.test.js`
- Modify: `cloudfunctions/forecast/scoring.js`
- Modify: `docs/sky-observations.md`

- [ ] **Step 1: 写“不足样本不校准”和“小幅有界”失败测试**

要求：`sampleCount < 30` 原值返回；达到 30 条后只能在明确常量范围内微调，建议第一版上限 `±5` 个百分点；输出必须包含 `source: 'accuracyStats'`、样本数和应用幅度。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/forecast/test/calibration.test.js`

Expected: 至少有一项失败，因为现有模块直接读取历史观测并使用旧分桶。

- [ ] **Step 3: 改为读取 accuracyStats 并保留旧结构降级**

新接口：

```js
async function getCalibrationProfile(db, cityCode) {}
function applyBoundedCalibration(probability, sceneType, profile) {}
```

不得因为统计不存在、字段异常或数据库超时改变原始概率。校准只改 `probability`，不改霞况评分和火烧云鲜艳度。

- [ ] **Step 4: 更新说明文档和测试**

文档明确四档命中规则、30 条门槛、30 天窗口、±5 上限，以及“准确率不是出现概率”。

Run: `npm test --prefix cloudfunctions/forecast`

Expected: PASS。

- [ ] **Step 5: 提交有界校准**

Run: `git add cloudfunctions/forecast/calibration.js cloudfunctions/forecast/scoring.js cloudfunctions/forecast/test/calibration.test.js docs/sky-observations.md`

Run: `git commit -m "feat: calibrate probability with bounded city stats"`

---

## Task 11: 配置数据库索引、权限与部署说明

**Files:**
- Create: `docs/cloudbase-national-confidence-setup.md`
- Modify: `README.md`

- [ ] **Step 1: 编写集合与权限清单**

记录以下集合均设置为“小程序端不可直接读写，仅云函数访问”：`forecastRecords`、`skyFeedback`、`skyObservations`、`accuracyStats`。

- [ ] **Step 2: 编写精确索引清单**

至少包含：

```text
forecastRecords: forecastId unique
skyFeedback: forecastId + anonymousUserHash unique
skyFeedback: eventKey + reviewStatus + reviewScore
skyObservations: feedbackId + sceneType unique
skyObservations: cityCode + sceneType + observedAt
accuracyStats: cityCode + windowDays unique
```

- [ ] **Step 3: 编写部署顺序与回退开关**

部署顺序：数据库集合/索引 → `forecast` → `skyFeedback` → `cityAccuracy` → 小程序代码。增加环境变量开关：`ENABLE_FORECAST_RECORDS`、`ENABLE_SKY_FEEDBACK_V2`、`ENABLE_CITY_ACCURACY`；默认分阶段开启。

- [ ] **Step 4: 增加隐私与数据保留说明**

说明匿名哈希、约 1 km 网格、不收照片、不存精确轨迹；原始反馈建议保留 180 天，标准观测和聚合统计按业务分析周期保留。

- [ ] **Step 5: 检查文档并提交**

Run: `rg -n "forecastRecords|skyFeedback|skyObservations|accuracyStats|ENABLE_" docs/cloudbase-national-confidence-setup.md README.md`

Expected: 四个集合和三个开关均有部署说明。

Run: `git add docs/cloudbase-national-confidence-setup.md README.md`

Run: `git commit -m "docs: add confidence loop deployment guide"`

---

## Task 12: 完整验证、兼容性检查和发布准备

**Files:**
- Modify only if verification exposes a defect; do not add unrelated features.

- [ ] **Step 1: 运行全部自动化测试**

Run:

```powershell
npm test --prefix cloudfunctions/forecast
npm test --prefix cloudfunctions/skyFeedback
node --test cloudfunctions/cityAccuracy/test
node --test miniprogram/test
```

Expected: 全部 PASS，0 failed。

- [ ] **Step 2: 执行 JavaScript 和 JSON 语法检查**

Run:

```powershell
node --check cloudfunctions/forecast/index.js
node --check cloudfunctions/skyFeedback/index.js
node --check cloudfunctions/cityAccuracy/index.js
node -e "JSON.parse(require('fs').readFileSync('miniprogram/app.json','utf8')); console.log('app.json ok')"
```

Expected: 无语法错误，输出 `app.json ok`。

- [ ] **Step 3: 云函数端到端验证**

依次验证：

1. `forecast` 对上海、北京各返回稳定 `forecastId` 和 high/medium/low 可信度。
2. 人为模拟单模型缺失，预报仍返回且可信度降级。
3. 观赏窗口外反馈被拒绝。
4. 三个不同测试用户的高信任 provisional 一致反馈能晋升并写入 `skyObservations`。
5. `cityAccuracy` 在 29 条时不返回百分比，在 30 条时返回准确率。

- [ ] **Step 4: 小程序页面回归**

开发者工具和真机各检查：首页天气/霞况、城市切换、GPS 定位、详情页、反馈表单、城市准确率页、分享、降雨卡、14 天天气。特别验证旧缓存城市与旧版无 `forecastConfidence` 数据不会白屏。

- [ ] **Step 5: 检查变更范围和占位内容**

Run:

```powershell
git diff --check
rg -n "TODO|FIXME|placeholder|待实现" cloudfunctions/forecast cloudfunctions/skyFeedback cloudfunctions/cityAccuracy miniprogram/pages miniprogram/utils
git status --short
```

Expected: `git diff --check` 无输出；无未解释占位；只有本方案范围内文件发生变化。

- [ ] **Step 6: 形成发布提交**

Run: `git add cloudfunctions miniprogram docs README.md`

Run: `git commit -m "feat: add nationwide forecast confidence loop"`

如果前面每个任务均已提交且此时无剩余变更，则不要创建空提交。

---

## Spec Coverage Checklist

- [ ] 全国 `cityCode` 主键、区县元数据和约 1 km 位置网格已覆盖。
- [ ] 新鲜度、完整度、EC/GFS 一致性和高/中/低可信度已覆盖。
- [ ] 首页紧凑可信度、详情解释和独立准确率页已覆盖。
- [ ] 观赏时段限定、结构化反馈、匿名化和限频已覆盖。
- [ ] `provisional`、`auto_approved`、`rejected` 与冷启动共识晋升已覆盖。
- [ ] `skyFeedback`、`skyObservations`、`accuracyStats` 职责分离已覆盖。
- [ ] 30 天、三类霞况、30 条门槛和四档命中规则已覆盖。
- [ ] 有界校准、异常降级、旧记录兼容、隐私与部署顺序已覆盖。
