const HOUR = 60 * 60 * 1000
const CHINA_OFFSET = 8 * HOUR

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function chinaDate(now) {
  return new Date(now.getTime() + CHINA_OFFSET).toISOString().slice(0, 10)
}

function parseSunTime(date, time) {
  return new Date(`${date}T${time}:00+08:00`)
}

function formatTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date)
}

function isBadWeather(text) {
  return /雨|雪|雷|雾|霾|沙尘|冰雹/.test(text || '')
}

function average(records, key, fallback) {
  if (!records.length) return fallback
  return records.reduce((total, item) => total + number(item[key], fallback), 0) / records.length
}

function selectHours(hourly, start, end) {
  const lower = start.getTime() - HOUR
  const upper = end.getTime() + HOUR
  return hourly.filter((item) => {
    const time = new Date(item.fxTime).getTime()
    return time >= lower && time <= upper
  })
}

function getMetrics(records, daily) {
  const cloud = average(records, 'cloud', number(daily.cloud, 50))
  const humidity = average(records, 'humidity', number(daily.humidity, 65))
  const wind = average(records, 'windSpeed', number(daily.windSpeedDay, 10))
  const rainProbability = Math.max(...records.map((item) => number(item.pop, 0)), 0)
  const hasPrecipitation = records.some((item) => number(item.precip, 0) > 0 || isBadWeather(item.text))
  return { cloud, humidity, wind, rainProbability, hasPrecipitation, visibility: number(daily.vis, 10) }
}

function cloudScore(cloud) {
  return clamp(1 - Math.abs(cloud - 55) / 55, 0, 1)
}

function skyScore(metrics) {
  const rain = metrics.hasPrecipitation ? 0 : 1 - metrics.rainProbability / 100
  const visibility = clamp((metrics.visibility - 2) / 10, 0, 1)
  const humidity = clamp(1 - Math.abs(metrics.humidity - 65) / 50, 0, 1)
  const wind = metrics.wind <= 25 ? 1 : clamp(1 - (metrics.wind - 25) / 35, 0, 1)
  let score = 100 * (cloudScore(metrics.cloud) * 0.4 + rain * 0.25 + visibility * 0.15 + humidity * 0.1 + wind * 0.1)
  if (metrics.hasPrecipitation || metrics.rainProbability >= 80 || metrics.visibility < 3) score = Math.min(score, 35)
  return Math.round(clamp(score, 0, 100))
}

function fireCloudScore(metrics, baseScore) {
  const moisture = clamp(1 - Math.abs(metrics.humidity - 70) / 35, 0, 1)
  const cloud = clamp(1 - Math.abs(metrics.cloud - 55) / 40, 0, 1)
  const score = baseScore * 0.75 + moisture * 15 + cloud * 10
  return Math.round(clamp(metrics.hasPrecipitation ? Math.min(score, 30) : score, 0, 95))
}

function tier(score) {
  if (score >= 70) return { key: 'high', label: '值得期待' }
  if (score >= 40) return { key: 'medium', label: '不妨看看' }
  return { key: 'low', label: '不太明显' }
}

function reasonFor(metrics, type) {
  if (metrics.hasPrecipitation || metrics.rainProbability >= 70) return '降水可能性较高，光照条件有限'
  if (metrics.visibility < 5) return '能见度一般，色彩可能受影响'
  if (metrics.cloud < 20) return '云量偏少，天空层次可能有限'
  if (metrics.cloud > 80) return '云层偏厚，阳光可能被遮挡'
  return type === '火烧云' ? '云量与水汽条件较适中' : '云量适中，暂无明显降水'
}

function buildItem(type, score, start, end, metrics, direction) {
  const level = tier(score)
  return {
    type,
    score,
    time: `${formatTime(start)}–${formatTime(end)}`,
    reason: reasonFor(metrics, type),
    direction: level.key === 'high' ? direction : '',
    tier: level.key,
    label: level.label,
    showDirection: level.key === 'high'
  }
}

function relativeLabel(date, kind, today) {
  const prefix = date === today ? '今天' : '明日'
  return `${prefix}${kind === 'sunrise' ? '清晨' : '傍晚'}`
}

function getWindows(daily, now) {
  const today = chinaDate(now)
  const horizon = now.getTime() + 24 * HOUR
  const windows = []
  daily.forEach((day) => {
    [['sunrise', -45, 15], ['sunset', -30, 25]].forEach(([kind, before, after]) => {
      if (!day[kind]) return
      const solar = parseSunTime(day.fxDate, day[kind])
      const start = new Date(solar.getTime() + before * 60 * 1000)
      const end = new Date(solar.getTime() + after * 60 * 1000)
      if (end.getTime() > now.getTime() && start.getTime() < horizon) {
        windows.push({ kind, start, end, daily: day, title: relativeLabel(day.fxDate, kind, today) })
      }
    })
  })
  return windows.sort((a, b) => a.start - b.start).slice(0, 2)
}

function buildWindow(window, hourly) {
  const metrics = getMetrics(selectHours(hourly, window.start, window.end), window.daily)
  const type = window.kind === 'sunrise' ? '朝霞' : '晚霞'
  const direction = window.kind === 'sunrise' ? '面向东侧天空' : '面向西侧天空'
  const sky = buildItem(type, skyScore(metrics), window.start, window.end, metrics, direction)
  const fire = buildItem('火烧云', fireCloudScore(metrics, sky.score), window.start, window.end, metrics, direction)
  const skies = [sky, fire]
  const hero = skies.reduce((best, item) => item.score > best.score ? item : best)
  return {
    title: window.title,
    time: sky.time,
    skies,
    hero: { ...hero, displayTitle: hero.type },
    secondarySkies: skies.filter((item) => item.type !== hero.type)
  }
}

function buildRainEvents(hourly, now) {
  const horizon = now.getTime() + 24 * HOUR
  const rainHours = hourly.filter((item) => {
    const time = new Date(item.fxTime).getTime()
    return time >= now.getTime() && time < horizon &&
      (number(item.pop, 0) >= 40 || number(item.precip, 0) > 0 || isBadWeather(item.text))
  })
  if (!rainHours.length) return []
  const probability = Math.max(...rainHours.map((item) => number(item.pop, 0)))
  return [{
    probability,
    time: `${formatTime(new Date(rainHours[0].fxTime))}–${formatTime(new Date(rainHours[rainHours.length - 1].fxTime))}`,
    text: '有降水可能，出门建议带伞'
  }]
}

function trendLabel(date, today) {
  const days = Math.round((parseSunTime(date, '12:00') - parseSunTime(today, '12:00')) / (24 * HOUR))
  return ['今天', '明天', '后天'][days] || `${date.slice(5, 7)}月${date.slice(8)}日`
}

function buildForecastView({ city, hourly, daily, alerts, now = new Date() }) {
  const windows = getWindows(daily, now).map((window) => buildWindow(window, hourly))
  if (windows.length < 2) throw new Error('未获得足够的日出日落预报数据')
  const rainEvents = buildRainEvents(hourly, now)
  const alert = alerts[0]
  const today = chinaDate(now)
  return {
    city,
    updatedAt: `更新于 ${formatTime(now)}`,
    primaryWindow: windows[0],
    secondaryWindow: windows[1],
    skyWindows: windows,
    allLow: windows.every((window) => window.skies.every((item) => item.tier === 'low')),
    hasRain: rainEvents.length > 0,
    rain: rainEvents.length ? { events: rainEvents, primary: rainEvents[0] } : null,
    warning: alert ? { title: alert.headline || alert.eventType.name, detail: alert.description } : null,
    trend: daily.filter((day) => day.fxDate >= today).slice(0, 3).map((day) => ({
      day: trendLabel(day.fxDate, today),
      weather: day.textDay,
      temperature: `${day.tempMin}–${day.tempMax}℃`,
      precipitation: `${day.precip || 0}mm`
    }))
  }
}

module.exports = { buildForecastView }
