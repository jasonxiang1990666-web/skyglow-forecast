const https = require('https')
const { buildModelReferenceFromSnapshots } = require('./model-reference')

const HOUR = 60 * 60 * 1000
const REQUEST_TIMEOUT = 12000
const MAX_TARGET_GAP = 2 * HOUR
const FORECAST_HOURS = 72

const SOURCES = {
  GFS: {
    source: 'GFS',
    provider: 'open-meteo-gfs',
    providerLabel: 'Open-Meteo GFS（NOAA GFS 模式）',
    endpointEnv: 'GFS_FORECAST_API_URL',
    apiKeyEnv: 'GFS_FORECAST_API_KEY',
    defaultUrl: 'https://api.open-meteo.com/v1/gfs',
    hourly: ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation', 'relative_humidity_2m', 'visibility'],
    humidityMode: 'native'
  },
  EC: {
    source: 'EC',
    provider: 'open-meteo-ecmwf',
    providerLabel: 'Open-Meteo ECMWF（ECMWF IFS HRES）',
    endpointEnv: 'EC_FORECAST_API_URL',
    apiKeyEnv: 'EC_FORECAST_API_KEY',
    defaultUrl: 'https://api.open-meteo.com/v1/ecmwf',
    hourly: ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation', 'temperature_2m', 'dew_point_2m', 'visibility'],
    humidityMode: 'dewPoint'
  }
}

function finite(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function toMilliseconds(value) {
  const parsed = finite(value)
  if (parsed === null) return 0
  return parsed < 100000000000 ? parsed * 1000 : parsed
}

function relativeHumidity(temperature, dewPoint) {
  if (temperature === null || dewPoint === null) return null
  const saturation = Math.exp((17.625 * temperature) / (243.04 + temperature))
  const actual = Math.exp((17.625 * dewPoint) / (243.04 + dewPoint))
  return clamp((actual / saturation) * 100, 0, 100)
}

function requestJson(url, source) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'SunsetWeatherLiveModel/1.0' } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${source} provider returned HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error(`${source} provider returned invalid JSON`))
        }
      })
    })
    request.setTimeout(REQUEST_TIMEOUT, () => request.destroy(new Error(`${source} provider request timed out`)))
    request.on('error', reject)
  })
}

function buildUrl(config, latitude, longitude) {
  const url = new URL(process.env[config.endpointEnv] || config.defaultUrl)
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', config.hourly.join(','))
  url.searchParams.set('forecast_hours', String(FORECAST_HOURS))
  url.searchParams.set('timeformat', 'unixtime')
  url.searchParams.set('timezone', 'GMT')
  if (process.env[config.apiKeyEnv]) url.searchParams.set('apikey', process.env[config.apiKeyEnv])
  return url.toString()
}

function hourlyValue(hourly, key, index) {
  return hourly && Array.isArray(hourly[key]) ? finite(hourly[key][index]) : null
}

function nearestIndex(times, targetAt) {
  let bestIndex = -1
  let bestDistance = Infinity
  times.forEach((rawTime, index) => {
    const timestamp = toMilliseconds(rawTime)
    const distance = Math.abs(timestamp - targetAt)
    if (timestamp && distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  })
  return bestIndex >= 0 && bestDistance <= MAX_TARGET_GAP ? bestIndex : -1
}

function snapshotAt(payload, config, latitude, longitude, targetAt) {
  const hourly = payload && payload.hourly
  const times = hourly && Array.isArray(hourly.time) ? hourly.time : []
  const index = nearestIndex(times, targetAt)
  if (index < 0) return null

  const validAt = toMilliseconds(times[index])
  const totalCloud = hourlyValue(hourly, 'cloud_cover', index)
  const precipitation = hourlyValue(hourly, 'precipitation', index)
  if (totalCloud === null || precipitation === null) return null

  const humidity = config.humidityMode === 'native'
    ? hourlyValue(hourly, 'relative_humidity_2m', index)
    : relativeHumidity(hourlyValue(hourly, 'temperature_2m', index), hourlyValue(hourly, 'dew_point_2m', index))

  return {
    source: config.source,
    provider: config.provider,
    providerLabel: config.providerLabel,
    status: 'ready',
    city: '',
    latitude,
    longitude,
    runAt: Date.now(),
    validAt,
    totalCloud: clamp(totalCloud, 0, 100),
    lowCloud: hourlyValue(hourly, 'cloud_cover_low', index),
    midCloud: hourlyValue(hourly, 'cloud_cover_mid', index),
    highCloud: hourlyValue(hourly, 'cloud_cover_high', index),
    precipitation: Math.max(0, precipitation),
    humidity,
    visibility: (() => {
      const value = hourlyValue(hourly, 'visibility', index)
      return value === null ? null : Math.max(0, value / 1000)
    })(),
    note: '基于用户当前位置的实时 EC/GFS 请求，未读取 modelSnapshots'
  }
}

async function fetchSource(config, latitude, longitude, targets) {
  try {
    const payload = await requestJson(buildUrl(config, latitude, longitude), config.source)
    return targets.map((target) => snapshotAt(payload, config, latitude, longitude, target.targetAt))
  } catch (error) {
    console.warn(`${config.source} 实时请求失败`, error.message)
    return targets.map(() => null)
  }
}

async function getLiveModelReferences({ city, latitude, longitude, targets = [] }) {
  const lat = finite(latitude)
  const lon = finite(longitude)
  if (lat === null || lon === null || !targets.length) return {}

  const [ecSnapshots, gfsSnapshots] = await Promise.all([
    fetchSource(SOURCES.EC, lat, lon, targets),
    fetchSource(SOURCES.GFS, lat, lon, targets)
  ])

  return targets.reduce((result, target, index) => {
    result[target.kind] = buildModelReferenceFromSnapshots({
      city,
      targetAt: target.targetAt,
      scene: target.kind,
      ecSnapshot: ecSnapshots[index],
      gfsSnapshot: gfsSnapshots[index]
    })
    return result
  }, {})
}

module.exports = { getLiveModelReferences }
