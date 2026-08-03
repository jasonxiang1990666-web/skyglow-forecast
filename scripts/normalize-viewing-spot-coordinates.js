/* Normalizes imported viewing-spot coordinates to GCJ-02 for wx.openLocation. */
const fs = require('fs')

const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: node scripts/normalize-viewing-spot-coordinates.js <json-lines-file>')

const PI = Math.PI
const A = 6378245.0
const EE = 0.00669342162296594323

function outOfChina(latitude, longitude) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271
}

function transformLatitude(longitude, latitude) {
  let value = -100 + 2 * longitude + 3 * latitude + 0.2 * latitude * latitude + 0.1 * longitude * latitude + 0.2 * Math.sqrt(Math.abs(longitude))
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3
  value += (20 * Math.sin(latitude * PI) + 40 * Math.sin(latitude / 3 * PI)) * 2 / 3
  return value + (160 * Math.sin(latitude / 12 * PI) + 320 * Math.sin(latitude * PI / 30)) * 2 / 3
}

function transformLongitude(longitude, latitude) {
  let value = 300 + longitude + 2 * latitude + 0.1 * longitude * longitude + 0.1 * longitude * latitude + 0.1 * Math.sqrt(Math.abs(longitude))
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3
  value += (20 * Math.sin(longitude * PI) + 40 * Math.sin(longitude / 3 * PI)) * 2 / 3
  return value + (150 * Math.sin(longitude / 12 * PI) + 300 * Math.sin(longitude / 30 * PI)) * 2 / 3
}

function wgs84ToGcj02(latitude, longitude) {
  if (outOfChina(latitude, longitude)) return { latitude, longitude }
  const latitudeDelta = transformLatitude(longitude - 105, latitude - 35)
  const longitudeDelta = transformLongitude(longitude - 105, latitude - 35)
  const radLatitude = latitude / 180 * PI
  const magic = 1 - EE * Math.sin(radLatitude) * Math.sin(radLatitude)
  const sqrtMagic = Math.sqrt(magic)
  const adjustedLatitude = latitudeDelta * 180 / ((A * (1 - EE)) / (magic * sqrtMagic) * PI)
  const adjustedLongitude = longitudeDelta * 180 / (A / sqrtMagic * Math.cos(radLatitude) * PI)
  return { latitude: latitude + adjustedLatitude, longitude: longitude + adjustedLongitude }
}

const records = fs.readFileSync(inputPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
let converted = 0
for (const record of records) {
  const source = String(record.coordinateSource || '')
  const isWgs84 = /OpenStreetMap|Mapcarta|Nominatim/.test(source)
  if (isWgs84 && record.coordinateSystem !== 'GCJ-02') {
    const convertedPoint = wgs84ToGcj02(Number(record.latitude), Number(record.longitude))
    record.latitude = Number(convertedPoint.latitude.toFixed(6))
    record.longitude = Number(convertedPoint.longitude.toFixed(6))
    record.originalCoordinateSystem = 'WGS-84'
    converted += 1
  }
  record.coordinateSystem = 'GCJ-02'
}
fs.writeFileSync(inputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
console.log(`Normalized ${records.length} records to GCJ-02; converted ${converted} WGS-84 records.`)
