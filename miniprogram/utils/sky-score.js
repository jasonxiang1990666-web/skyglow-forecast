const TIER_RULES = [
  { min: 70, key: 'high', label: '值得期待' },
  { min: 40, key: 'medium', label: '不妨看看' },
  { min: 0, key: 'low', label: '不太明显' }
]

function getTier(score) {
  return TIER_RULES.find((rule) => score >= rule.min) || TIER_RULES[2]
}

function buildSkyItem(item) {
  const tier = getTier(item.score)
  return {
    ...item,
    tier: tier.key,
    label: tier.label,
    showDirection: tier.key === 'high' && Boolean(item.direction)
  }
}

function build24HourView(rawForecast) {
  const skyWindows = rawForecast.skyWindows.map((window) => {
    const skies = window.skies.map(buildSkyItem)
    const primarySky = skies.find((item) => item.type === '朝霞' || item.type === '晚霞') || skies[0]
    const fireCloud = skies.find((item) => item.type === '火烧云') || skies[1] || null
    return {
      ...window,
      skies,
      primarySky,
      fireCloud,
      hero: {
        ...primarySky,
        displayTitle: primarySky.type
      },
      secondarySkies: fireCloud ? [fireCloud] : []
    }
  })
  const allLow = skyWindows.every((window) => window.skies.every((item) => item.tier === 'low'))
  const hasRain = Boolean(rawForecast.rain && rawForecast.rain.events && rawForecast.rain.events.length)

  return {
    ...rawForecast,
    skyWindows,
    primaryWindow: skyWindows[0],
    secondaryWindow: skyWindows[1],
    allLow,
    hasRain,
    rain: hasRain ? { ...rawForecast.rain, primary: rawForecast.rain.events[0] } : null
  }
}

module.exports = { build24HourView, getTier }
