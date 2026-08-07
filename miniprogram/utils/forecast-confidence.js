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

module.exports = { confidencePresentation }
