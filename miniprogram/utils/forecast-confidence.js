const LABELS = {
  high: '高可信度',
  medium: '中可信度',
  low: '低可信度'
}

const SUMMARIES = {
  consistent: 'EC/GFS 较一致',
  different: 'EC/GFS 存在差异',
  conflict: 'EC/GFS 分歧较大',
  unavailable: 'EC/GFS 模型数据不完整'
}

const DETAIL_FALLBACK = {
  available: false,
  message: '当前仅提供基础霞况预报'
}

function confidencePresentation(confidence) {
  if (!confidence || !LABELS[confidence.level]) {
    return {
      label: '可信度待同步',
      tone: 'pending',
      summary: '模型数据待同步'
    }
  }

  return {
    label: LABELS[confidence.level],
    tone: confidence.level,
    summary: SUMMARIES[confidence.modelAgreement] || '模型数据待同步'
  }
}

function formatUpdatedAt(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function confidenceDetails(confidence, selected = {}) {
  if (!confidence || !selected.forecastId || !LABELS[confidence.level] || confidence.modelAgreement === 'unavailable' || !Array.isArray(confidence.reasons)) {
    return { ...DETAIL_FALLBACK }
  }
  const updatedAt = formatUpdatedAt(confidence.weatherUpdatedAt)
  if (!updatedAt) return { ...DETAIL_FALLBACK }

  return {
    available: true,
    label: LABELS[confidence.level],
    tone: confidence.level,
    updatedAt,
    modelAgreement: SUMMARIES[confidence.modelAgreement] || 'EC/GFS 模型数据待同步',
    reasons: confidence.reasons.filter((reason) => typeof reason === 'string' && reason.trim()).slice(0, 3)
  }
}

module.exports = { confidencePresentation, confidenceDetails }
