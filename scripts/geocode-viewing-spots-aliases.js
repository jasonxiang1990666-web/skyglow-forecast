/* Completes unmatched candidate records with landmark-level navigation anchors. */
const fs = require('fs')
const path = require('path')

const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: node scripts/geocode-viewing-spots-aliases.js <input-json-lines-file>')

const aliases = {
  'beijing-candidate-01': '奥林匹克森林公园', 'beijing-candidate-03': '通州大运河森林公园',
  'beijing-candidate-04': '西海湿地公园', 'beijing-candidate-05': '玉渊潭公园',
  'beijing-candidate-07': '亮马河国际风情水岸', 'beijing-candidate-08': '北海公园',
  'guangzhou-candidate-02': '广州塔', 'guangzhou-candidate-03': '二沙岛',
  'guangzhou-candidate-05': '猎德大桥', 'guangzhou-candidate-06': '白云山',
  'guangzhou-candidate-07': '南沙滨海公园', 'guangzhou-candidate-08': '海鸥岛',
  'guangzhou-candidate-09': '大夫山森林公园',
  'shenzhen-candidate-04': '莲花山公园', 'shenzhen-candidate-07': '小梅沙',
  'shenzhen-candidate-08': '杨梅坑', 'shenzhen-candidate-10': '香蜜公园',
  'hangzhou-candidate-01': '断桥残雪', 'hangzhou-candidate-03': '钱江新城城市阳台',
  'hangzhou-candidate-05': '六和塔', 'hangzhou-candidate-06': '宝石山',
  'hangzhou-candidate-07': '九溪烟树', 'hangzhou-candidate-08': '拱宸桥',
  'nanjing-candidate-01': '玄武湖公园', 'nanjing-candidate-02': '紫金山天文台',
  'nanjing-candidate-04': '鱼嘴湿地公园', 'nanjing-candidate-06': '幕燕滨江风貌区',
  'nanjing-candidate-07': '老山森林公园', 'nanjing-candidate-09': '牛首山文化旅游区',
  'nanjing-candidate-10': '神策门',
  'wuhan-candidate-01': '东湖听涛景区', 'wuhan-candidate-04': '汉口江滩',
  'wuhan-candidate-05': '武昌江滩', 'wuhan-candidate-06': '鹦鹉洲长江大桥',
  'wuhan-candidate-07': '月湖风景区', 'wuhan-candidate-08': '晴川阁',
  'wuhan-candidate-09': '后官湖湿地公园', 'wuhan-candidate-10': '金银湖湿地公园',
  'chengdu-candidate-04': '丹景台', 'chengdu-candidate-07': '成都露天音乐公园',
  'chengdu-candidate-08': '浣花溪公园',
  'xian-candidate-02': '曲江池遗址公园', 'xian-candidate-07': '永宁门',
  'xian-candidate-08': '灞桥生态湿地公园', 'xian-candidate-09': '西安世博园',
  'xian-candidate-10': '沣河梁家滩湿地公园',
  'chongqing-candidate-01': '南山一棵树观景台', 'chongqing-candidate-02': '弹子石老街',
  'chongqing-candidate-03': '长嘉汇购物公园', 'chongqing-candidate-04': '鹅岭公园',
  'chongqing-candidate-10': '鹅公岩大桥'
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const records = fs.readFileSync(inputPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

async function search(query) {
  const endpoint = new URL('https://nominatim.openstreetmap.org/search')
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('format', 'jsonv2')
  endpoint.searchParams.set('limit', '1')
  const response = await fetch(endpoint, { headers: { 'User-Agent': 'XiaGuangYuJian-ViewingSpots/1.0 (non-commercial data curation)' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const results = await response.json()
  return results[0] || null
}

async function main() {
  const report = []
  for (const record of records) {
    if (Number.isFinite(Number(record.latitude)) && Number.isFinite(Number(record.longitude))) continue
    const alias = aliases[record._id] || record.name
    let result = null
    let error = ''
    try { result = await search(`${alias}, ${record.city}, 中国`) } catch (cause) { error = cause.message }
    if (result && Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon))) {
      record.latitude = Number(Number(result.lat).toFixed(6))
      record.longitude = Number(Number(result.lon).toFixed(6))
      record.coordinateStatus = 'geocodedAreaAnchor'
      record.coordinateSource = 'OpenStreetMap Nominatim'
      record.coordinateNote = `按标准地标“${alias}”取得的区域导航锚点；发布前应在腾讯地图复核入口与实际观赏区域。`
      report.push({ id: record._id, status: 'matched', alias, latitude: record.latitude, longitude: record.longitude, displayName: result.display_name })
      console.log(`matched ${record._id}: ${alias}`)
    } else {
      report.push({ id: record._id, status: 'unmatched', alias, error: error || 'No result' })
      console.log(`unmatched ${record._id}: ${alias}`)
    }
    await wait(1100)
  }
  const directory = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath)).replace('-with-coordinates', '')
  const outputPath = path.join(directory, `${base}-with-all-available-coordinates.json`)
  const reportPath = path.join(directory, `${base}-alias-geocode-report.json`)
  fs.writeFileSync(outputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Complete: ${report.filter((item) => item.status === 'matched').length}/${report.length} alias matches`)
  console.log(outputPath)
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
