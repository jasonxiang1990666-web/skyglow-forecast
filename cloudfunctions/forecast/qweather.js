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

const PROVINCE_PREFIXES = [
  '内蒙古自治区', '广西壮族自治区', '宁夏回族自治区', '新疆维吾尔自治区', '西藏自治区',
  '香港特别行政区', '澳门特别行政区',
  '北京市', '天津市', '上海市', '重庆市',
  '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省', '江苏省', '浙江省', '安徽省',
  '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '海南省',
  '四川省', '贵州省', '云南省', '陕西省', '甘肃省', '青海省', '台湾省',
  '内蒙古', '广西', '宁夏', '新疆', '西藏', '香港', '澳门',
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西',
  '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西',
  '甘肃', '青海', '台湾'
]

function normalizeCityKeyword(keyword) {
  const compact = String(keyword || '').replace(/\s/g, '')
  const province = PROVINCE_PREFIXES.find((item) => compact.startsWith(item))
  const city = province ? compact.slice(province.length) : compact
  return city.replace(/市$/, '')
}

async function searchCities(keyword) {
  const raw = String(keyword || '').trim()
  if (!raw) return []

  const normalized = normalizeCityKeyword(raw)
  const candidates = [...new Set([raw, normalized].filter(Boolean))]

  for (const location of candidates) {
    try {
      const data = await apiGet('/geo/v2/city/lookup', {
        location,
        range: 'cn',
        number: '20',
        lang: 'zh'
      })
      const locations = data.location || []
      if (locations.length) {
        return locations.map((item) => ({
          id: item.id,
          name: item.name,
          province: item.adm1 || item.adm2 || ''
        }))
      }
    } catch (error) {
      // 城市搜索没有结果是正常情况，继续尝试去掉省份后的关键词。
    }
  }

  return []
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

async function getTwoWeekWeather(locationId) {
  const [hourly, daily] = await Promise.all([
    apiGet('/v7/weather/168h', { location: locationId, lang: 'zh', unit: 'm' }),
    apiGet('/v7/weather/15d', { location: locationId, lang: 'zh', unit: 'm' })
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

module.exports = { lookupCity, lookupCoordinates, searchCities, getWeather, getTwoWeekWeather, getAlerts }
