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

module.exports = { getNext24HourForecast }
