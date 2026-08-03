/* Final English/common-name pass for a small set of Chinese POIs. */
const fs = require('fs')
const path = require('path')
const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: node scripts/geocode-viewing-spots-final-aliases.js <input-json-lines-file>')

const aliases = {
  'beijing-candidate-03': 'Grand Canal Forest Park, Tongzhou, Beijing',
  'beijing-candidate-07': 'Liangma River, Chaoyang, Beijing',
  'guangzhou-candidate-07': 'Nansha Binhai Park, Guangzhou',
  'hangzhou-candidate-03': 'City Balcony, Qianjiang New Town, Hangzhou',
  'nanjing-candidate-04': 'Yuzui Wetland Park, Nanjing',
  'nanjing-candidate-06': 'Muyan Binjiang Scenic Area, Nanjing',
  'nanjing-candidate-09': 'Niushoushan Cultural Tourism Zone, Nanjing',
  'wuhan-candidate-09': 'Houguan Lake Wetland Park, Wuhan',
  'wuhan-candidate-10': 'Jinyin Lake Wetland Park, Wuhan',
  'xian-candidate-08': 'Baqiao Ecological Wetland Park, Xi An',
  'xian-candidate-10': 'Fenghe Liangjiatan Wetland Park, Xi An',
  'chongqing-candidate-01': 'Nanshan Yikeshu Viewing Platform, Chongqing',
  'chongqing-candidate-02': 'Danzishi Old Street, Chongqing'
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
  return (await response.json())[0] || null
}

async function main() {
  const report = []
  for (const record of records) {
    if (Number.isFinite(Number(record.latitude)) && Number.isFinite(Number(record.longitude))) continue
    const alias = aliases[record._id] || record.name
    let result = null
    let error = ''
    try { result = await search(alias) } catch (cause) { error = cause.message }
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
  const base = path.basename(inputPath, path.extname(inputPath)).replace('-with-all-available-coordinates', '')
  const outputPath = path.join(directory, `${base}-with-coordinates.json`)
  const reportPath = path.join(directory, `${base}-final-geocode-report.json`)
  fs.writeFileSync(outputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Complete: ${report.filter((item) => item.status === 'matched').length}/${report.length} final matches`)
  console.log(outputPath)
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
