const { getHourlyWeather } = require('./qweather')

const HOUR = 60 * 60 * 1000
const CACHE_TTL = 90 * 60 * 1000
const cache = new Map()

// Nationwide overview is sampled from representative cities. It deliberately
// avoids presenting a continuous grid forecast that the current data source
// does not provide.
const CITIES = [
  ['乌鲁木齐', '101130101', 43.8, 87.6],
  ['哈尔滨', '101050101', 45.8, 126.5],
  ['呼和浩特', '101080101', 40.8, 111.7],
  ['北京', '101010100', 39.9, 116.4],
  ['银川', '101170101', 38.5, 106.2],
  ['兰州', '101160101', 36.1, 103.8],
  ['西安', '101110101', 34.3, 108.9],
  ['成都', '101270101', 30.6, 104.1],
  ['武汉', '101200101', 30.6, 114.3],
  ['上海', '101020100', 31.2, 121.5],
  ['杭州', '101210101', 30.3, 120.2],
  ['福州', '101230101', 26.1, 119.3],
  ['广州', '101280101', 23.1, 113.3],
  ['南宁', '101300101', 22.8, 108.3],
  ['昆明', '101290101', 25.0, 102.7],
  ['海口', '101310101', 20.0, 110.3]
].map(([name, id, lat, lon]) => ({ name, id, lat, lon }))

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function chinaTimeKey(date) {
  return new Date(date.getTime() + 8 * HOUR).toISOString().slice(0, 13)
}

function formatChinaDateTime(date) {
  const local = new Date(date.getTime() + 8 * HOUR)
  const month = String(local.getUTCMonth() + 1).padStart(2, '0')
  const day = String(local.getUTCDate()).padStart(2, '0')
  const hour = String(local.getUTCHours()).padStart(2, '0')
  return `${month}月${day}日 ${hour}:00`
}

function positionFor(city) {
  return {
    left: Number((((city.lon - 72) / (136 - 72)) * 100).toFixed(1)),
    top: Number((((55 - city.lat) / (55 - 18)) * 100).toFixed(1))
  }
}

function nearestHourly(hours, targetAt) {
  return hours.reduce((best, hour) => {
    if (!best) return hour
    return Math.abs(new Date(hour.fxTime).getTime() - targetAt) < Math.abs(new Date(best.fxTime).getTime() - targetAt)
      ? hour
      : best
  }, null)
}

function hasRain(hour) {
  return number(hour.pop) >= 40 || number(hour.precip) > 0 || /雨|雷/.test(hour.text || '')
}

function scoreHour(hour) {
  const cloud = number(hour.cloud, 50)
  const humidity = number(hour.humidity, 65)
  const wind = number(hour.windSpeed, 0)
  let score = 35
  score += hasRain(hour) ? -35 : 18
  score += cloud >= 20 && cloud <= 70 ? 20 : cloud <= 85 ? 8 : -8
  score += humidity >= 45 && humidity <= 85 ? 10 : -4
  score += wind >= 2 && wind <= 20 ? 5 : 0
  return Math.max(0, Math.min(100, Math.round(score)))
}

function levelFor(score) {
  if (score >= 70) return { key: 'high', label: '值得期待', color: '#c77a3a' }
  if (score >= 40) return { key: 'medium', label: '不妨看看', color: '#d6aa59' }
  return { key: 'low', label: '不太明显', color: '#aab9c7' }
}

async function mapWithLimit(items, worker, limit = 4) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await worker(items[index])
      } catch (error) {
        console.warn('全国城市概览数据获取失败', items[index].name, error.message)
        results[index] = null
      }
    }
  })
  await Promise.all(runners)
  return results.filter(Boolean)
}

async function buildNationalCityOverview({ targetAt, scene }) {
  const safeTargetAt = Number(targetAt)
  if (!Number.isFinite(safeTargetAt)) throw new Error('Missing overview target time')

  const cacheKey = `${scene || 'sunset'}:${chinaTimeKey(new Date(safeTargetAt))}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) return cached.value

  const cities = await mapWithLimit(CITIES, async (city) => {
    const hours = await getHourlyWeather(city.id)
    const hour = nearestHourly(hours, safeTargetAt)
    if (!hour) return null
    const score = scoreHour(hour)
    return {
      name: city.name,
      ...positionFor(city),
      score,
      weather: hour.text || '天气变化中',
      ...levelFor(score)
    }
  })

  if (cities.length < 6) throw new Error('Not enough city forecast data available')

  const result = {
    title: scene === 'sunrise' ? '全国重点城市朝霞概览' : '全国重点城市晚霞概览',
    validAt: formatChinaDateTime(new Date(safeTargetAt)),
    updatedAt: formatChinaDateTime(new Date()),
    cities,
    note: '基于重点城市逐小时预报汇总，不代表连续的全国格点预报；本地详情预报优先。'
  }
  cache.set(cacheKey, { createdAt: Date.now(), value: result })
  return result
}

module.exports = { buildNationalCityOverview }
