const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const SHANGHAI = {
  city: '上海',
  latitude: 31.2304,
  longitude: 121.4737
}
const DEFAULT_FORECAST_HOURS = 48
const MAX_FORECAST_HOURS = 72
const REQUEST_TIMEOUT = 12000
const WRITE_CONCURRENCY = 6

const MODEL_SOURCES = {
  GFS: {
    source: 'GFS',
    provider: 'open-meteo-gfs',
    providerLabel: 'Open-Meteo GFS（NOAA GFS 模式）',
    endpointEnv: 'GFS_FORECAST_API_URL',
    apiKeyEnv: 'GFS_FORECAST_API_KEY',
    defaultUrl: 'https://api.open-meteo.com/v1/gfs',
    hourlyVariables: [
      'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
      'precipitation', 'relative_humidity_2m', 'visibility'
    ],
    humidityMode: 'native',
    note: 'GFS 数值自动同步：云量分层、降水、相对湿度、能见度。云图尚未接入。'
  },
  EC: {
    source: 'EC',
    provider: 'open-meteo-ecmwf',
    providerLabel: 'Open-Meteo ECMWF（ECMWF IFS HRES）',
    endpointEnv: 'EC_FORECAST_API_URL',
    apiKeyEnv: 'EC_FORECAST_API_KEY',
    defaultUrl: 'https://api.open-meteo.com/v1/ecmwf',
    hourlyVariables: [
      'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
      'precipitation', 'temperature_2m', 'dew_point_2m', 'visibility'
    ],
    humidityMode: 'derivedFromDewPoint',
    note: 'EC 数值自动同步：云量分层、降水、相对湿度、能见度。相对湿度由气温与露点推导；云图尚未接入。'
  }
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function toMilliseconds(value) {
  const number = finiteNumber(value)
  if (number === null) return 0
  return number < 100000000000 ? number * 1000 : number
}

function hourlyValue(hourly, key, index) {
  return hourly && Array.isArray(hourly[key]) ? finiteNumber(hourly[key][index]) : null
}

function optionalPercentage(value) {
  return value === null ? null : clamp(value, 0, 100)
}

function calculateRelativeHumidity(temperature, dewPoint) {
  if (temperature === null || dewPoint === null) return null
  const saturation = Math.exp((17.625 * temperature) / (243.04 + temperature))
  const actual = Math.exp((17.625 * dewPoint) / (243.04 + dewPoint))
  return clamp((actual / saturation) * 100, 0, 100)
}

function visibilityKilometres(value) {
  if (value === null) return null
  // Open-Meteo 的 visibility 默认以米返回；小程序数据库统一存为 km。
  return Math.max(0, value / 1000)
}

function getLatestExpectedModelRun(now = Date.now()) {
  const date = new Date(now)
  const runHour = Math.floor(date.getUTCHours() / 6) * 6
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    runHour,
    0,
    0
  )
}

function getRequestedSources(value) {
  const source = String(value || 'ALL').trim().toUpperCase()
  if (source === 'ALL') return [MODEL_SOURCES.GFS, MODEL_SOURCES.EC]
  if (MODEL_SOURCES[source]) return [MODEL_SOURCES[source]]
  throw new Error('source 仅支持 GFS、EC 或 ALL')
}

function requestJson(url, source) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SunsetWeatherModelSync/1.1'
      }
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${source} provider returned HTTP ${response.statusCode}: ${text.slice(0, 240)}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error(`Unable to parse ${source} provider response: ${error.message}`))
        }
      })
    })
    request.setTimeout(REQUEST_TIMEOUT, () => {
      request.destroy(new Error(`${source} provider request timed out`))
    })
    request.on('error', reject)
  })
}

function buildProviderUrl(config, hours) {
  const baseUrl = process.env[config.endpointEnv] || config.defaultUrl
  const url = new URL(baseUrl)
  url.searchParams.set('latitude', String(SHANGHAI.latitude))
  url.searchParams.set('longitude', String(SHANGHAI.longitude))
  url.searchParams.set('hourly', config.hourlyVariables.join(','))
  url.searchParams.set('forecast_hours', String(hours))
  url.searchParams.set('timeformat', 'unixtime')
  url.searchParams.set('timezone', 'GMT')
  if (process.env[config.apiKeyEnv]) {
    url.searchParams.set('apikey', process.env[config.apiKeyEnv])
  }
  return url.toString()
}

function extractSnapshots(payload, config, runAt, now) {
  const hourly = payload && payload.hourly
  const times = hourly && hourly.time
  const clouds = hourly && hourly.cloud_cover
  const precipitation = hourly && hourly.precipitation
  if (!Array.isArray(times) || !Array.isArray(clouds) || !Array.isArray(precipitation)) {
    throw new Error(`${config.source} provider response does not contain hourly cloud_cover and precipitation arrays`)
  }

  return times.reduce((snapshots, rawTime, index) => {
    const validAt = toMilliseconds(rawTime)
    const totalCloud = finiteNumber(clouds[index])
    const rain = finiteNumber(precipitation[index])
    if (!validAt || validAt < now - 60 * 60 * 1000 || totalCloud === null || rain === null) {
      return snapshots
    }

    const nativeHumidity = hourlyValue(hourly, 'relative_humidity_2m', index)
    const humidity = config.humidityMode === 'derivedFromDewPoint'
      ? calculateRelativeHumidity(
        hourlyValue(hourly, 'temperature_2m', index),
        hourlyValue(hourly, 'dew_point_2m', index)
      )
      : nativeHumidity

    snapshots.push({
      source: config.source,
      provider: config.provider,
      providerLabel: config.providerLabel,
      status: 'ready',
      city: SHANGHAI.city,
      latitude: SHANGHAI.latitude,
      longitude: SHANGHAI.longitude,
      runAt,
      validAt,
      totalCloud: clamp(totalCloud, 0, 100),
      lowCloud: optionalPercentage(hourlyValue(hourly, 'cloud_cover_low', index)),
      midCloud: optionalPercentage(hourlyValue(hourly, 'cloud_cover_mid', index)),
      highCloud: optionalPercentage(hourlyValue(hourly, 'cloud_cover_high', index)),
      precipitation: Math.max(0, rain),
      humidity: optionalPercentage(humidity),
      visibility: visibilityKilometres(hourlyValue(hourly, 'visibility', index)),
      note: config.note
    })
    return snapshots
  }, [])
}

async function mapWithConcurrency(items, worker, concurrency = WRITE_CONCURRENCY) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker))
  return results
}

async function upsertSnapshots(snapshots) {
  const source = snapshots[0].source
  const existingResult = await db.collection('modelSnapshots').where({
    source,
    city: SHANGHAI.city
  }).orderBy('validAt', 'desc').limit(100).get()
  const existingByValidAt = new Map((existingResult.data || []).map((item) => [Number(item.validAt), item._id]))

  const actions = await mapWithConcurrency(snapshots, async (snapshot) => {
    const data = {
      ...snapshot,
      syncedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    const existingId = existingByValidAt.get(snapshot.validAt)
    if (existingId) {
      await db.collection('modelSnapshots').doc(existingId).update({ data })
      return 'updated'
    }
    await db.collection('modelSnapshots').add({
      data: {
        ...data,
        createdAt: db.serverDate()
      }
    })
    return 'inserted'
  })

  return actions.reduce((result, action) => {
    result[action] += 1
    return result
  }, { inserted: 0, updated: 0 })
}

async function syncSource(config, hours, now, dryRun) {
  const runAt = getLatestExpectedModelRun(now)
  const payload = await requestJson(buildProviderUrl(config, hours), config.source)
  const snapshots = extractSnapshots(payload, config, runAt, now)
  if (!snapshots.length) throw new Error(`No valid Shanghai ${config.source} hourly snapshots were returned`)

  if (dryRun) {
    return {
      dryRun: true,
      source: config.source,
      provider: config.provider,
      city: SHANGHAI.city,
      runAt,
      count: snapshots.length,
      firstSnapshot: snapshots[0],
      lastSnapshot: snapshots[snapshots.length - 1]
    }
  }

  const result = await upsertSnapshots(snapshots)
  return {
    source: config.source,
    provider: config.provider,
    city: SHANGHAI.city,
    runAt,
    count: snapshots.length,
    ...result,
    firstValidAt: snapshots[0].validAt,
    lastValidAt: snapshots[snapshots.length - 1].validAt
  }
}

exports.main = async (event = {}) => {
  const requestedHours = finiteNumber(event.hours)
  const hours = clamp(
    Math.round(requestedHours === null ? DEFAULT_FORECAST_HOURS : requestedHours),
    6,
    MAX_FORECAST_HOURS
  )
  const requestedSources = getRequestedSources(event.source)
  const now = Date.now()
  const settled = await Promise.allSettled(
    requestedSources.map((config) => syncSource(config, hours, now, Boolean(event.dryRun)))
  )
  const results = settled
    .filter((item) => item.status === 'fulfilled')
    .map((item) => item.value)
  const failed = settled.reduce((items, item, index) => {
    if (item.status === 'rejected') {
      items.push({ source: requestedSources[index].source, message: item.reason.message })
    }
    return items
  }, [])

  if (!results.length) {
    throw new Error(failed.map((item) => `${item.source}: ${item.message}`).join('；'))
  }

  return {
    dryRun: Boolean(event.dryRun),
    source: requestedSources.length === 1 ? requestedSources[0].source : 'ALL',
    city: SHANGHAI.city,
    requestedHours: hours,
    results,
    failed
  }
}
