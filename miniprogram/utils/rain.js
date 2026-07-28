function withWarningRainFallback(forecast) {
  if (!forecast || forecast.shortRain || !forecast.warning) return forecast

  const warning = forecast.warning
  const content = `${warning.title || ''} ${warning.detail || ''}`
  if (!/雷雨|暴雨|大雨|强降水|短时强降水|雷电/.test(content)) return forecast

  return {
    ...forecast,
    shortRain: {
      headline: '未来3小时可能有强降雨',
      detail: `${warning.title || '已发布降雨预警'}，请以安全预警为准`,
      probability: 100,
      precipitationText: '以预警为准',
      isSoon: true,
      isCurrent: false,
      alertDriven: true,
      timeline: [],
      summaryTimeline: []
    }
  }
}

module.exports = { withWarningRainFallback }
