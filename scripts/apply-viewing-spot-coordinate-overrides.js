/* Applies publicly sourced navigation anchors after automated geocoding. */
const fs = require('fs')

const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: node scripts/apply-viewing-spot-coordinate-overrides.js <json-lines-file>')

const overrides = {
  'guangzhou-candidate-07': { latitude: 22.74052, longitude: 113.600407, source: 'Amap public POI', precision: 'publicPoi', note: '南沙滨海公园公开 POI 坐标；请在腾讯地图复核具体入园口。' },
  'hangzhou-candidate-03': { latitude: 30.2428, longitude: 120.1938, source: 'Public travel map listing', precision: 'publicPoi', note: '钱江新城城市阳台公开地点坐标；请在腾讯地图复核具体临江入口。' },
  'nanjing-candidate-04': { latitude: 31.974255, longitude: 118.666004, source: 'Amap public POI', precision: 'publicPoi', note: '南京鱼嘴湿地公园公开 POI 坐标；请在腾讯地图复核步道入口。' },
  'nanjing-candidate-06': { latitude: 32.1394, longitude: 118.79682, source: 'OpenStreetMap / Mapcarta', precision: 'areaAnchor', note: '幕燕滨江风貌区公开园区中心锚点；并非单一观景台坐标。' },
  'nanjing-candidate-09': { latitude: 31.903309, longitude: 118.74415, source: 'Amap public POI', precision: 'publicPoi', note: '牛首山文化旅游区公开 POI 坐标；园内高处区域需按开放安排进入。' },
  'wuhan-candidate-09': { latitude: 30.559529, longitude: 114.073184, source: 'Amap public POI', precision: 'publicPoi', note: '后官湖国家湿地公园公开 POI 坐标；请在腾讯地图复核正门和步道。' },
  'wuhan-candidate-10': { latitude: 30.654509, longitude: 114.191885, source: 'Amap public POI', precision: 'publicPoi', note: '金银湖国家城市湿地公园公开 POI 坐标；请在腾讯地图复核入口。' },
  'xian-candidate-08': { latitude: 34.282107, longitude: 109.099055, source: 'Amap public POI', precision: 'publicPoi', note: '灞桥生态湿地公园公开 POI 坐标；请在腾讯地图复核入口。' },
  'xian-candidate-10': { latitude: 34.08, longitude: 108.65, source: 'Public-area estimate', precision: 'approximateAreaAnchor', note: '梁家滩湿地公园公开资料仅能确认沣河中游、兴隆街道梁家滩周边；此为范围级临时锚点，发布前必须在腾讯地图人工选定入口。' },
  'chongqing-candidate-01': { latitude: 29.545316, longitude: 106.602505, source: 'Amap public POI', precision: 'publicPoi', note: '南山一棵树景区公开 POI 坐标；请留意景区开放时间与门票。' },
  'chongqing-candidate-02': { latitude: 29.58261, longitude: 106.58435, source: 'OpenStreetMap / Mapcarta', precision: 'publicPoi', note: '长嘉汇弹子石老街公开地点坐标；请在腾讯地图复核具体观景平台。' }
}

const records = fs.readFileSync(inputPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
for (const record of records) {
  const override = overrides[record._id]
  if (!override) continue
  record.latitude = override.latitude
  record.longitude = override.longitude
  record.coordinateStatus = override.precision === 'approximateAreaAnchor' ? 'approximateAreaAnchor' : 'publicMapAnchor'
  record.coordinateSource = override.source
  record.coordinateNote = override.note
}

const missing = records.filter((record) => !Number.isFinite(Number(record.latitude)) || !Number.isFinite(Number(record.longitude)))
if (missing.length) throw new Error(`Missing coordinates: ${missing.map((record) => record._id).join(', ')}`)
fs.writeFileSync(inputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
console.log(`Complete: ${records.length} records have coordinates; ${overrides['xian-candidate-10'].precision} retained for xian-candidate-10.`)
