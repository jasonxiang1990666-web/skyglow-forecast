const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const HOUR = 60 * 60 * 1000
const SHANGHAI = { city: '上海', latitude: 31.2304, longitude: 121.4737 }
const SOURCES = ['EC', 'GFS']
const SCENES = ['sunrise', 'sunset']
const SNAPSHOT_MATCH_WINDOW = 6 * HOUR

// This project's ordinary CloudBase functions have a 60-second ceiling. The
// timer alternates providers and renders the two scene maps serially so a
// single-core renderer is not asked to download and plot four model files at
// the same time. Operators can still explicitly request EC, GFS, or ALL.
function scheduledSource(now = Date.now()) {
  const chinaHour = new Date(now + 8 * HOUR).getUTCHours()
  return [5, 17].includes(chinaHour) ? 'EC' : 'GFS'
}

function finiteNumber(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function toMilliseconds(value) {
  const numeric = finiteNumber(value)
  return numeric && numeric < 100000000000 ? numeric * 1000 : numeric
}

function chinaDateText(at) {
  const china = new Date(at + 8 * HOUR)
  return [china.getUTCFullYear(), String(china.getUTCMonth() + 1).padStart(2, '0'), String(china.getUTCDate()).padStart(2, '0')].join('-')
}

// NOAA sunrise equation.  It avoids a second weather-provider dependency just to
// determine which Shanghai model timestep belongs to the next dawn or dusk.
function solarAt(dateText, latitude, longitude, scene) {
  const [year, month, day] = dateText.split('-').map(Number)
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / (24 * HOUR))
  const longitudeHour = longitude / 15
  const approximate = dayOfYear + ((scene === 'sunrise' ? 6 : 18) - longitudeHour) / 24
  const meanAnomaly = (0.9856 * approximate) - 3.289
  let trueLongitude = meanAnomaly + (1.916 * Math.sin(meanAnomaly * Math.PI / 180)) + (0.02 * Math.sin(2 * meanAnomaly * Math.PI / 180)) + 282.634
  trueLongitude = (trueLongitude + 360) % 360
  let rightAscension = Math.atan(0.91764 * Math.tan(trueLongitude * Math.PI / 180)) * 180 / Math.PI
  rightAscension = (rightAscension + 360) % 360
  rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90
  rightAscension /= 15
  const sinDeclination = 0.39782 * Math.sin(trueLongitude * Math.PI / 180)
  const cosDeclination = Math.cos(Math.asin(sinDeclination))
  const cosHourAngle = (Math.cos(90.833 * Math.PI / 180) - sinDeclination * Math.sin(latitude * Math.PI / 180)) / (cosDeclination * Math.cos(latitude * Math.PI / 180))
  if (cosHourAngle > 1 || cosHourAngle < -1) return 0
  let hourAngle = Math.acos(cosHourAngle) * 180 / Math.PI
  if (scene === 'sunrise') hourAngle = 360 - hourAngle
  hourAngle /= 15
  const localMean = hourAngle + rightAscension - (0.06571 * approximate) - 6.622
  const utcHour = ((localMean - longitudeHour) % 24 + 24) % 24
  return Date.UTC(year, month - 1, day) + Math.round(utcHour * HOUR)
}

function nextSolarTarget(scene, now = Date.now()) {
  for (let offset = 0; offset < 4; offset += 1) {
    const dateText = chinaDateText(now + offset * 24 * HOUR)
    const at = solarAt(dateText, SHANGHAI.latitude, SHANGHAI.longitude, scene)
    if (at > now) return at
  }
  throw new Error(`无法计算下一次${scene === 'sunrise' ? '日出' : '日落'}时间`)
}

function selectNearestSnapshot(snapshots, targetAt) {
  let selected = null
  snapshots.forEach((snapshot) => {
    const validAt = toMilliseconds(snapshot.validAt)
    if (!validAt) return
    const distance = Math.abs(validAt - targetAt)
    if (distance > SNAPSHOT_MATCH_WINDOW) return
    if (!selected || distance < selected.distance) selected = { snapshot, distance }
  })
  return selected ? selected.snapshot : null
}

async function latestSnapshots(source) {
  const result = await db.collection('modelSnapshots').where({
    source,
    city: SHANGHAI.city,
    status: 'ready'
  }).orderBy('validAt', 'desc').limit(100).get()
  return result.data || []
}

function requestImage(rendererUrl, payload) {
  const token = process.env.MODEL_IMAGE_RENDERER_TOKEN || ''
  const url = new URL(rendererUrl)
  if (url.protocol !== 'https:') throw new Error('MODEL_IMAGE_RENDERER_URL 必须使用 HTTPS 地址')
  const body = Buffer.from(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname.replace(/\/$/, '')}/render`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      timeout: 45000
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const content = Buffer.concat(chunks)
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`云量图服务返回 ${response.statusCode}: ${content.toString('utf8').slice(0, 240)}`))
        }
        if (!String(response.headers['content-type'] || '').includes('image/png')) {
          return reject(new Error('云量图服务没有返回 PNG 图片'))
        }
        resolve({
          content,
          effectiveValidAt: toMilliseconds(response.headers['x-model-effective-valid-at']) || 0,
          effectiveRunAt: toMilliseconds(response.headers['x-model-effective-run-at']) || 0
        })
      })
    })
    request.on('timeout', () => request.destroy(new Error('云量图服务请求超时')))
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

async function renderOne({ source, scene, targetAt, snapshot, dryRun }) {
  const validAt = toMilliseconds(snapshot.validAt)
  const runAt = toMilliseconds(snapshot.runAt)
  const output = {
    source,
    scene,
    targetAt,
    snapshotId: snapshot._id,
    runAt,
    validAt
  }
  if (dryRun) return { ...output, dryRun: true }

  const rendererUrl = process.env.MODEL_IMAGE_RENDERER_URL
  if (!rendererUrl) throw new Error('缺少 MODEL_IMAGE_RENDERER_URL；请先部署 model-image-renderer 云托管服务')
  const image = await requestImage(rendererUrl, {
    source,
    city: SHANGHAI.city,
    latitude: SHANGHAI.latitude,
    longitude: SHANGHAI.longitude,
    runAt,
    validAt,
    targetAt,
    scene,
    bounds: { west: 116.5, east: 124.5, south: 27.5, north: 35.0 }
  })
  const effectiveValidAt = image.effectiveValidAt || validAt
  const effectiveRunAt = image.effectiveRunAt || runAt
  const cloudPath = `model-images/shanghai/${source.toLowerCase()}/${scene}/${new Date(effectiveRunAt).toISOString().slice(0, 13).replace(/[-:T]/g, '')}-${Math.round(effectiveValidAt / HOUR)}.png`
  const upload = await cloud.uploadFile({ cloudPath, fileContent: image.content })
  await db.collection('modelSnapshots').doc(snapshot._id).update({
    data: {
      imageFileId: upload.fileID,
      imageStatus: 'ready',
      imageGeneratedAt: db.serverDate(),
      imageTargetAt: targetAt,
      imageRunAt: effectiveRunAt,
      imageValidAt: effectiveValidAt,
      imageBounds: { west: 116.5, east: 124.5, south: 27.5, north: 35.0 },
      imageProvider: source === 'EC' ? 'ECMWF Open Data IFS' : 'NOAA GFS NOMADS',
      imageError: ''
    }
  })
  return { ...output, imageFileId: upload.fileID, effectiveRunAt, effectiveValidAt }
}

exports.main = async (event = {}) => {
  const hasRequestedSource = Boolean(event.source)
  const requested = String(event.source || scheduledSource()).toUpperCase()
  const sources = requested === 'ALL' ? SOURCES : SOURCES.filter((item) => item === requested)
  if (!sources.length) throw new Error('source 仅支持 EC、GFS 或 ALL')
  const dryRun = event.dryRun === true
  const now = Date.now()
  const targets = SCENES.map((scene) => ({ scene, targetAt: nextSolarTarget(scene, now) }))
  const tasks = []
  const unavailable = []
  for (const source of sources) {
    const snapshots = await latestSnapshots(source)
    targets.forEach(({ scene, targetAt }) => {
      const snapshot = selectNearestSnapshot(snapshots, targetAt)
      if (snapshot) tasks.push({ source, scene, targetAt, snapshot, dryRun })
      else unavailable.push({ source, scene, targetAt, reason: '未找到目标时段前后 6 小时内的上海模式快照' })
    })
  }
  const rendered = []
  const failed = []
  for (const task of tasks) {
    try {
      rendered.push(await renderOne(task))
    } catch (error) {
      failed.push({ ...task, message: error.message })
    }
  }
  return {
    city: SHANGHAI.city,
    dryRun,
    requestedSource: requested,
    sourceSelectedBySchedule: !hasRequestedSource,
    targets,
    rendered,
    unavailable,
    failed
  }
}
