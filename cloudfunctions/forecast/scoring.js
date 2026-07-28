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

function buildDetailTimeline(window, hourly) {
  const lower = window.start.getTime() - 3 * HOUR
  const upper = window.end.getTime() + 3 * HOUR
  return hourly
    .filter((item) => {
      const time = new Date(item.fxTime).getTime()
      return time >= lower && time <= upper
    })
    .map((item) => {
      const time = new Date(item.fxTime)
      const precipitation = number(item.precip, 0)
      const probability = number(item.pop, 0)
      return {
        timestamp: time.getTime(),
        time: formatTime(time),
        weather: item.text || '天气变化中',
        probability,
        precipitationText: formatRainAmount(precipitation),
        cloud: Math.round(number(item.cloud, 0)),
        isWindow: time.getTime() >= window.start.getTime() && time.getTime() <= window.end.getTime(),
        isRaining: probability >= 40 || precipitation > 0 || isBadWeather(item.text)
      }
    })
}

function buildFactors(metrics) {
  const favorable = []
  const unfavorable = []

  if (metrics.cloud >= 30 && metrics.cloud <= 70) favorable.push('云量适中，天空层次更容易显现')
  else if (metrics.cloud < 30) unfavorable.push('云量偏少，色彩层次可能有限')
  else unfavorable.push('云层偏厚，日光可能被遮挡')

  if (!metrics.hasPrecipitation && metrics.rainProbability < 40) favorable.push('降水信号较弱，光照条件更稳定')
  else unfavorable.push('降水可能会削弱光照和能见度')

  if (metrics.visibility >= 8) favorable.push('能见度较好，远处天空更清晰')
  else if (metrics.visibility < 5) unfavorable.push('能见度有限，色彩可能不够通透')

  if (metrics.wind > 25) unfavorable.push('风力偏大，户外观赏需注意安全')

  return { favorable: favorable.slice(0, 3), unfavorable: unfavorable.slice(0, 3) }
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
    kind: window.kind,
    date: window.daily.fxDate,
    time: sky.time,
    startAt: window.start.getTime(),
    endAt: window.end.getTime(),
    startTime: formatTime(window.start),
    endTime: formatTime(window.end),
    skies,
    hero: { ...hero, displayTitle: hero.type },
    secondarySkies: skies.filter((item) => item.type !== hero.type),
    hourlyTimeline: buildDetailTimeline(window, hourly),
    factors: buildFactors(metrics)
  }
}

function groupRainRecords(records) {
  if (!records.length) return []
  const groups = []
  let group = []
  records.forEach((item) => {
    const currentTime = new Date(item.fxTime).getTime()
    const previous = group[group.length - 1]
    const previousTime = previous ? new Date(previous.fxTime).getTime() : 0
    if (previous && currentTime - previousTime > HOUR * 1.5) {
      groups.push(group)
      group = []
    }
    group.push(item)
  })
  if (group.length) groups.push(group)

  return groups.map((groupRecords) => buildRainEvent(groupRecords))
}

function buildRainEvents(hourly, now) {
  const horizon = now.getTime() + 24 * HOUR
  const rainHours = hourly.filter((item) => {
    const time = new Date(item.fxTime).getTime()
    return time >= now.getTime() && time < horizon &&
      (number(item.pop, 0) >= 40 || number(item.precip, 0) > 0 || isBadWeather(item.text))
  })
  return groupRainRecords(rainHours)
}

function rainIntensity(records) {
  const texts = records.map((item) => item.text || '').join(' ')
  const maximum = Math.max(...records.map((item) => number(item.precip, 0)), 0)
  if (/雷/.test(texts)) return '雷阵雨'
  if (/暴雨|大暴雨/.test(texts) || maximum >= 10) return '大雨'
  if (/中雨/.test(texts) || maximum >= 2.5) return '中雨'
  if (/小雨|雨/.test(texts) || maximum > 0) return '小雨'
  return '有雨'
}

function formatRainAmount(amount) {
  const fixed = amount < 1 ? amount.toFixed(1) : amount.toFixed(1).replace(/\.0$/, '')
  return `${fixed}mm`
}

function formatDuration(start, end) {
  const hours = Math.max(1, Math.round((end - start) / HOUR))
  return `约${hours}小时`
}

function buildRainEvent(records) {
  const start = new Date(records[0].fxTime)
  const last = new Date(records[records.length - 1].fxTime)
  const end = new Date(last.getTime() + HOUR)
  const probability = Math.max(...records.map((item) => number(item.pop, 0)), 0)
  const amount = records.reduce((total, item) => total + number(item.precip, 0), 0)
  const intensity = rainIntensity(records)
  return {
    startAt: start.getTime(),
    endAt: end.getTime(),
    startTime: formatTime(start),
    endTime: formatTime(end),
    time: `${formatTime(start)}–${formatTime(end)}`,
    duration: formatDuration(start, end),
    probability,
    precipitation: amount,
    precipitationText: formatRainAmount(amount),
    intensity,
    text: `${intensity}，出门建议带伞`
  }
}

function buildRainTimeline(hourly, now) {
  const horizon = now.getTime() + 12 * HOUR
  return hourly
    .filter((item) => {
      const time = new Date(item.fxTime).getTime()
      return time >= now.getTime() - HOUR && time < horizon
    })
    .map((item) => {
      const time = new Date(item.fxTime)
      const precipitation = number(item.precip, 0)
      const probability = number(item.pop, 0)
      return {
        timestamp: time.getTime(),
        time: formatTime(time),
        weather: item.text || '天气变化中',
        probability,
        precipitation,
        precipitationText: formatRainAmount(precipitation),
        isRaining: probability >= 40 || precipitation > 0 || isBadWeather(item.text)
      }
    })
}

function pickTimelineNodes(timeline, count = 6) {
  if (timeline.length <= count) return timeline
  const indexes = new Set()
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.round(index * (timeline.length - 1) / (count - 1)))
  }
  return [...indexes].map((index) => timeline[index])
}

function buildShortRainForecast(hourly, now) {
  const timeline = buildRainTimeline(hourly, now)
  const rainHours = timeline.filter((item) => item.isRaining)
  if (!rainHours.length) return null

  const records = rainHours.map((point) => ({
    fxTime: new Date(point.timestamp).toISOString(),
    pop: point.probability,
    precip: point.precipitation,
    text: point.weather
  }))
  const event = groupRainRecords(records)[0]
  if (!event) return null
  const startsIn = event.startAt - now.getTime()
  const isCurrent = event.startAt <= now.getTime() && event.endAt > now.getTime()
  const isSoon = event.startAt <= now.getTime() + 3 * HOUR && event.endAt > now.getTime()
  const hoursUntil = Math.max(1, Math.ceil(startsIn / HOUR))
  let headline = '未来12小时可能有雨'
  if (isCurrent) headline = `正在下${event.intensity}`
  else if (startsIn <= HOUR) headline = '雨快来了'
  else if (isSoon) headline = `约${hoursUntil}小时后有${event.intensity}`

  const detail = isCurrent
    ? `预计至${event.endTime}前后结束 · 累计${event.precipitationText}`
    : `${event.startTime}开始 · 预计持续${event.duration}`

  return {
    ...event,
    headline,
    detail,
    isSoon,
    isCurrent,
    timeline,
    summaryTimeline: pickTimelineNodes(timeline)
  }
}

function rainImpactFor(window, rainEvents) {
  const overlap = rainEvents.find((event) => event.startAt < window.end.getTime() && event.endAt > window.start.getTime())
  return overlap ? `该时段有${overlap.intensity}，观赏条件受影响` : ''
}

function buildAlertRainForecast(alert, now) {
  if (!alert) return null
  const title = alert.headline || (alert.eventType && alert.eventType.name) || ''
  const detail = alert.description || ''
  const content = `${title} ${detail}`
  if (!/雷雨|暴雨|大雨|强降水|短时强降水|雷电/.test(content)) return null

  return {
    headline: '未来3小时可能有强降雨',
    detail: `${title || '已发布降雨预警'}，请以安全预警为准`,
    probability: 100,
    precipitationText: '以预警为准',
    isSoon: true,
    isCurrent: false,
    alertDriven: true,
    timeline: [],
    summaryTimeline: []
  }
}

function trendLabel(date, today) {
  const days = Math.round((parseSunTime(date, '12:00') - parseSunTime(today, '12:00')) / (24 * HOUR))
  return ['今天', '明天', '后天'][days] || `${date.slice(5, 7)}月${date.slice(8)}日`
}

function weekLabel(date, today) {
  const offset = Math.round((parseSunTime(date, '12:00') - parseSunTime(today, '12:00')) / (24 * HOUR))
  if (offset === 0) return '今天'
  if (offset === 1) return '明天'
  return `周${['日', '一', '二', '三', '四', '五', '六'][parseSunTime(date, '12:00').getDay()]}`
}

function buildTwoWeekForecastView({ city, hourly, daily, now = new Date() }) {
  const today = chinaDate(now)
  const days = daily
    .filter((day) => day.fxDate >= today)
    .slice(0, 14)
    .map((day, index) => {
      const hourlyRecords = index < 7
        ? hourly.filter((item) => chinaDate(new Date(item.fxTime)) === day.fxDate)
        : []
      const hasProbability = hourlyRecords.length > 0
      const probability = hasProbability
        ? Math.max(...hourlyRecords.map((item) => number(item.pop, 0)), 0)
        : null
      const precipitation = number(day.precip, 0)
      return {
        date: day.fxDate,
        day: weekLabel(day.fxDate, today),
        dateText: `${Number(day.fxDate.slice(5, 7))}月${Number(day.fxDate.slice(8))}日`,
        weather: day.textDay || day.textNight || '天气变化中',
        temperature: `${day.tempMin}–${day.tempMax}℃`,
        probability,
        probabilityText: hasProbability ? `${probability}%` : '暂不提供',
        precipitation,
        precipitationText: formatRainAmount(precipitation),
        hasRain: (probability || 0) >= 40 || precipitation > 0 || isBadWeather(day.textDay) || isBadWeather(day.textNight)
      }
    })

  if (!days.length) throw new Error('未获得未来两周的天气预报数据')
  return {
    city,
    updatedAt: `更新于 ${formatTime(now)}`,
    days
  }
}

function buildForecastView({ city, hourly, daily, alerts, now = new Date() }) {
  const rainEvents = buildRainEvents(hourly, now)
  const windowDefinitions = getWindows(daily, now)
  const windows = windowDefinitions.map((window) => ({
    ...buildWindow(window, hourly),
    rainImpact: rainImpactFor(window, rainEvents)
  }))
  if (windows.length < 2) throw new Error('未获得足够的日出日落预报数据')
  const alert = alerts[0]
  const shortRain = buildShortRainForecast(hourly, now) || buildAlertRainForecast(alert, now)
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
    shortRain,
    warning: alert ? { title: alert.headline || alert.eventType.name, detail: alert.description } : null,
    trend: daily.filter((day) => day.fxDate >= today).slice(0, 3).map((day) => ({
      day: trendLabel(day.fxDate, today),
      weather: day.textDay,
      temperature: `${day.tempMin}–${day.tempMax}℃`,
      precipitation: `${day.precip || 0}mm`
    }))
  }
}

module.exports = { buildForecastView, buildTwoWeekForecastView }
