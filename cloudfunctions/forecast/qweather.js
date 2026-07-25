const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')

function getConfig() {
  const apiHost = process.env.QWEATHER_API_HOST
  const credentialId = process.env.QWEATHER_CREDENTIAL_ID
  const projectId = process.env.QWEATHER_PROJECT_ID
  const privateKey = process.env.QWEATHER_PRIVATE_KEY
  if (!apiHost || !credentialId || !projectId || !privateKey) {
    throw new Error('缺少和风天气云函数环境变量')
  }
  return {
    apiHost: apiHost.replace(/\/$/, ''),
    credentialId,
    projectId,
    privateKey: privateKey.replace(/\\n/g, '\n')
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function createJwt(config) {
  const iat = Math.floor(Date.now() / 1000) - 30
  const header = base64url(JSON.stringify({ alg: 'EdDSA', kid: config.credentialId }))
  const payload = base64url(JSON.stringify({ sub: config.projectId, iat, exp: iat + 900 }))
  const unsignedToken = `${header}.${payload}`
  const signature = crypto.sign(null, Buffer.from(unsignedToken), config.privateKey)
  return `${unsignedToken}.${base64url(signature)}`
}

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (response) => {
      const encoding = String(response.headers['content-encoding'] || '').toLowerCase()
      let stream = response
      if (encoding.includes('gzip')) stream = response.pipe(zlib.createGunzip())
      if (encoding.includes('deflate')) stream = response.pipe(zlib.createInflate())
      if (encoding.includes('br') && typeof zlib.createBrotliDecompress === 'function') {
        stream = response.pipe(zlib.createBrotliDecompress())
      }
      let body = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => { body += chunk })
      stream.on('error', reject)
      stream.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (response.statusCode >= 400 || (data.code && data.code !== '200')) {
            reject(new Error(`和风天气请求失败：${data.code || response.statusCode}`))
            return
          }
          resolve(data)
        } catch (error) {
          reject(new Error(`和风天气返回了无法解析的数据（HTTP ${response.statusCode}）`))
        }
      })
    }).on('error', reject)
  })
}

async function apiGet(path, params) {
  const config = getConfig()
  const query = new URLSearchParams(params).toString()
  return requestJson(`${config.apiHost}${path}?${query}`, createJwt(config))
}

async function lookupCity(city) {
  const data = await apiGet('/geo/v2/city/lookup', { location: city, range: 'cn', number: '10', lang: 'zh' })
  const locations = data.location || []
  const exact = locations.find((item) => item.name === city)
  if (!exact) throw new Error(`未找到城市：${city}`)
  return exact
}

async function lookupCoordinates(latitude, longitude) {
  const lat = Number(latitude)
  const lon = Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('定位坐标无效')
  }
  const data = await apiGet('/geo/v2/city/lookup', {
    location: `${lon.toFixed(2)},${lat.toFixed(2)}`,
    range: 'cn',
    number: '1',
    lang: 'zh'
  })
  const location = (data.location || [])[0]
  if (!location) throw new Error('未找到定位城市')
  return location
}

async function getWeather(locationId) {
  const [hourly, daily] = await Promise.all([
    apiGet('/v7/weather/72h', { location: locationId, lang: 'zh', unit: 'm' }),
    apiGet('/v7/weather/3d', { location: locationId, lang: 'zh', unit: 'm' })
  ])
  return { hourly: hourly.hourly || [], daily: daily.daily || [] }
}

async function getAlerts(latitude, longitude) {
  try {
    const data = await apiGet(`/weatheralert/v1/current/${latitude}/${longitude}`, { localTime: 'true', lang: 'zh' })
    return data.alerts || []
  } catch (error) {
    console.warn('天气预警获取失败', error.message)
    return []
  }
}

module.exports = { lookupCity, lookupCoordinates, getWeather, getAlerts }
