/*
 * Enriches CloudBase JSON Lines viewing spots with navigation-anchor coordinates.
 * Uses the public Nominatim geocoder at a respectful rate of one request/second.
 * It deliberately never changes a record's publishing status.
 */
const fs = require('fs')
const path = require('path')

const inputPath = process.argv[2]
if (!inputPath) {
  throw new Error('Usage: node scripts/geocode-viewing-spots.js <input-json-lines-file>')
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const input = fs.readFileSync(inputPath, 'utf8').trim()
const records = input.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

async function search(query) {
  const endpoint = new URL('https://nominatim.openstreetmap.org/search')
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('format', 'jsonv2')
  endpoint.searchParams.set('limit', '1')
  endpoint.searchParams.set('addressdetails', '1')
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': 'XiaGuangYuJian-ViewingSpots/1.0 (non-commercial data curation)' }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const results = await response.json()
  return results[0] || null
}

async function main() {
  const report = []
  const enriched = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const queries = [
      `${record.name}, ${record.city}, 中国`,
      `${record.address}, ${record.city}, 中国`
    ]
    let result = null
    let matchedQuery = ''
    let errorMessage = ''

    for (const query of queries) {
      try {
        result = await search(query)
        matchedQuery = query
        if (result) break
      } catch (error) {
        errorMessage = error.message
      }
      await wait(1100)
    }

    const next = { ...record }
    if (result && Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon))) {
      next.latitude = Number(Number(result.lat).toFixed(6))
      next.longitude = Number(Number(result.lon).toFixed(6))
      next.coordinateStatus = 'geocodedAnchor'
      next.coordinateSource = 'OpenStreetMap Nominatim'
      next.coordinateNote = '公开地理编码得到的导航锚点；发布前应在腾讯地图复核入口与实际观赏区域。'
      report.push({ id: record._id, city: record.city, name: record.name, status: 'matched', query: matchedQuery, displayName: result.display_name, latitude: next.latitude, longitude: next.longitude })
    } else {
      next.coordinateStatus = 'needsVerification'
      report.push({ id: record._id, city: record.city, name: record.name, status: 'unmatched', query: matchedQuery, error: errorMessage || 'No result' })
    }
    enriched.push(next)
    console.log(`${index + 1}/${records.length} ${record.city} ${record.name}: ${result ? 'matched' : 'unmatched'}`)
    await wait(1100)
  }

  const directory = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath))
  const outputPath = path.join(directory, `${base}-with-coordinates.json`)
  const reportPath = path.join(directory, `${base}-geocode-report.json`)
  fs.writeFileSync(outputPath, `${enriched.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const matched = report.filter((item) => item.status === 'matched').length
  console.log(`Complete: ${matched}/${records.length} matched`)
  console.log(outputPath)
  console.log(reportPath)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
