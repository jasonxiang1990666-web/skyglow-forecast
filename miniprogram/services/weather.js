const { build24HourView } = require('../utils/sky-score')
const { USE_CLOUD_FORECAST } = require('../config/runtime')

const demoForecast = {
  date: '接下来24小时',
  updatedAt: '今天 20:00 更新',
  skyWindows: [
    {
      title: '今天傍晚',
      time: '18:49–19:27',
      skies: [
        { type: '晚霞', score: 82, time: '18:49–19:27', reason: '西侧云层条件较好', direction: '面向西侧天空' },
        { type: '火烧云', score: 46, time: '18:55 前后', reason: '色彩强度预计一般', direction: '' }
      ]
    },
    {
      title: '明日清晨',
      time: '05:02–05:38',
      skies: [
        { type: '朝霞', score: 68, time: '05:02–05:38', reason: '东侧云量适中', direction: '' },
        { type: '火烧云', score: 42, time: '05:10 前后', reason: '有机会出现暖色云层', direction: '' }
      ]
    }
  ],
  rain: {
    events: [
      { probability: 70, time: '明日 14:00–17:00', text: '有阵雨，出门建议带伞' }
    ]
  },
  warning: null,
  trend: [
    { day: '明天', weather: '多云', temperature: '26–34℃', precipitation: '30%' },
    { day: '后天', weather: '阵雨', temperature: '25–31℃', precipitation: '75%' },
    { day: '大后天', weather: '晴', temperature: '27–35℃', precipitation: '10%' }
  ]
}

function getNext24HourForecast(city) {
  if (USE_CLOUD_FORECAST) {
    return wx.cloud.callFunction({
      name: 'forecast',
      data: { city }
    }).then((response) => {
      if (!response.result || !response.result.primaryWindow) {
        throw new Error('云函数未返回有效预报')
      }
      return response.result
    })
  }

  // 本地开发阶段使用演示数据，避免未部署云函数时影响页面预览。
  return Promise.resolve({ ...build24HourView(demoForecast), city })
}

function getTwoWeekWeatherForecast(city) {
  if (USE_CLOUD_FORECAST) {
    return wx.cloud.callFunction({
      name: 'forecast',
      data: { action: 'twoWeekForecast', city }
    }).then((response) => {
      if (!response.result || !Array.isArray(response.result.days) || !response.result.days.length) {
        throw new Error('云函数未返回有效的两周天气预报')
      }
      return response.result
    })
  }

  return Promise.resolve({
    city,
    updatedAt: '演示数据',
    days: [
      ['今天', '7月28日', '多云', '29–34℃', 0, '0.0mm'],
      ['明天', '7月29日', '多云', '29–36℃', 10, '0.0mm'],
      ['周三', '7月30日', '小雨', '27–33℃', 65, '4.2mm'],
      ['周四', '7月31日', '阴', '26–31℃', 35, '0.6mm'],
      ['周五', '8月1日', '多云', '27–33℃', 15, '0.0mm'],
      ['周六', '8月2日', '晴', '28–35℃', 5, '0.0mm'],
      ['周日', '8月3日', '晴', '28–36℃', 0, '0.0mm'],
      ['周一', '8月4日', '多云', '27–34℃', null, '0.0mm'],
      ['周二', '8月5日', '小雨', '26–31℃', null, '3.1mm'],
      ['周三', '8月6日', '阴', '25–30℃', null, '1.2mm'],
      ['周四', '8月7日', '多云', '26–32℃', null, '0.0mm'],
      ['周五', '8月8日', '晴', '27–34℃', null, '0.0mm'],
      ['周六', '8月9日', '多云', '28–35℃', null, '0.0mm'],
      ['周日', '8月10日', '晴', '28–35℃', null, '0.0mm']
    ].map(([day, dateText, weather, temperature, probability, precipitationText]) => ({
      day,
      dateText,
      weather,
      temperature,
      probability,
      probabilityText: probability === null ? '暂不提供' : `${probability}%`,
      precipitationText,
      hasRain: (probability || 0) >= 40 || precipitationText !== '0.0mm'
    }))
  })
}

module.exports = { getNext24HourForecast, getTwoWeekWeatherForecast }
