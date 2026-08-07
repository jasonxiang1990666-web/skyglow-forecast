const { consensusSeenLevel } = require('./review')

const MIN_DISTINCT_USERS = 3
const MIN_PROVISIONAL_REVIEW_SCORE = 75

function strictLevel(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3
    ? value
    : null
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function scopeKey(row) {
  return [
    String(row.forecastId || row.eventKey || ''),
    String(row.sceneType || ''),
    finite(row.windowStart),
    finite(row.windowEnd)
  ].join('|')
}

function candidate(row) {
  if (!row || !row._id || !row.anonymousUserHash) return null
  const approved = row.reviewStatus === 'auto_approved'
  const highTrustProvisional = row.reviewStatus === 'provisional' &&
    typeof row.reviewScore === 'number' &&
    Number.isFinite(row.reviewScore) &&
    row.reviewScore >= MIN_PROVISIONAL_REVIEW_SCORE
  if (!approved && !highTrustProvisional) return null

  const seenLevel = consensusSeenLevel(row)
  if (seenLevel === null) return null
  const suppliedColor = row.colorIntensity !== null && row.colorIntensity !== undefined && row.colorIntensity !== ''
  const colorIntensity = suppliedColor ? strictLevel(row.colorIntensity) : seenLevel
  if (colorIntensity === null) return null

  return {
    row,
    id: String(row._id),
    user: String(row.anonymousUserHash),
    scope: scopeKey(row),
    approved,
    seenLevel,
    colorIntensity
  }
}

function candidateOrder(left, right) {
  if (left.user !== right.user) return left.user.localeCompare(right.user)
  if (left.approved !== right.approved) return left.approved ? -1 : 1
  const scoreDelta = (finite(right.row.reviewScore) || 0) - (finite(left.row.reviewScore) || 0)
  if (scoreDelta) return scoreDelta
  return left.id.localeCompare(right.id)
}

function uniqueCandidates(rows) {
  const seenUsers = new Set()
  return rows
    .map(candidate)
    .filter(Boolean)
    .sort(candidateOrder)
    .filter((item) => {
      if (seenUsers.has(item.user)) return false
      seenUsers.add(item.user)
      return true
    })
}

function roundedAverage(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function clusterOrder(left, right) {
  if (left.length !== right.length) return right.length - left.length
  const leftIds = left.map((item) => item.id).sort().join('|')
  const rightIds = right.map((item) => item.id).sort().join('|')
  return leftIds.localeCompare(rightIds)
}

function consensusCluster(candidates) {
  const clusters = []
  for (let seenFloor = 0; seenFloor <= 3; seenFloor += 1) {
    for (let colorFloor = 0; colorFloor <= 3; colorFloor += 1) {
      const cluster = candidates.filter((item) => (
        item.seenLevel >= seenFloor && item.seenLevel <= seenFloor + 1 &&
        item.colorIntensity >= colorFloor && item.colorIntensity <= colorFloor + 1
      ))
      if (cluster.length >= MIN_DISTINCT_USERS) clusters.push(cluster)
    }
  }
  clusters.sort(clusterOrder)
  return clusters[0] || []
}

function provisionalResult() {
  return {
    formed: false,
    status: 'provisional',
    observationStatus: 'provisional',
    observedLevel: null,
    seenLevel: null,
    colorIntensity: null,
    feedbackIds: [],
    distinctUserCount: 0
  }
}

function buildConsensus(rows = []) {
  const byScope = new Map()
  for (const item of uniqueCandidates(Array.isArray(rows) ? rows : [])) {
    if (!byScope.has(item.scope)) byScope.set(item.scope, [])
    byScope.get(item.scope).push(item)
  }

  const possible = [...byScope.entries()]
    .map(([scope, items]) => ({ scope, cluster: consensusCluster(items) }))
    .filter((item) => item.cluster.length >= MIN_DISTINCT_USERS)
    .sort((left, right) => clusterOrder(left.cluster, right.cluster) || left.scope.localeCompare(right.scope))
  if (!possible.length) return provisionalResult()

  const cluster = possible[0].cluster
  const seenLevel = roundedAverage(cluster.map((item) => item.seenLevel))
  const colorIntensity = roundedAverage(cluster.map((item) => item.colorIntensity))
  const sceneType = String(cluster[0].row.sceneType || '')
  const observedLevel = sceneType === 'fireCloud' ? colorIntensity : seenLevel
  return {
    formed: true,
    status: 'auto_approved',
    observationStatus: seenLevel > 0 ? 'observed' : 'not_observed',
    observedLevel,
    seenLevel,
    colorIntensity,
    feedbackIds: cluster.map((item) => item.id).sort(),
    distinctUserCount: cluster.length
  }
}

function promotableFeedbackIds(rows = []) {
  return buildConsensus(rows).feedbackIds
}

function authoritativeRows(rows, eventKey, forecastRecord) {
  return rows.filter((row) => (
    row &&
    row.eventKey === eventKey &&
    row.forecastId === forecastRecord.forecastId &&
    row.sceneType === forecastRecord.sceneType &&
    Number(row.windowStart) === Number(forecastRecord.windowStart) &&
    Number(row.windowEnd) === Number(forecastRecord.windowEnd)
  ))
}

function observationKey(forecastRecord) {
  return `${forecastRecord.forecastId}|${forecastRecord.sceneType}`
}

function buildObservation({ forecastRecord, consensus, rows, reviewedAt }) {
  const promotedRows = rows.filter((row) => consensus.feedbackIds.includes(String(row._id)))
  const reviewScores = promotedRows.map((row) => finite(row.reviewScore)).filter((value) => value !== null)
  return {
    forecastId: forecastRecord.forecastId,
    cityCode: String(forecastRecord.cityCode || ''),
    cityName: String(forecastRecord.cityName || ''),
    districtName: String(forecastRecord.districtName || ''),
    locationGrid: String(forecastRecord.locationGrid || ''),
    sceneType: forecastRecord.sceneType,
    observationDate: String(forecastRecord.observationDate || ''),
    windowStart: Number(forecastRecord.windowStart),
    windowEnd: Number(forecastRecord.windowEnd),
    observedAt: Number(forecastRecord.windowEnd),
    observationStatus: consensus.observationStatus,
    observedLevel: consensus.observedLevel,
    seenLevel: consensus.seenLevel,
    colorIntensity: consensus.colorIntensity,
    forecastScore: finite(forecastRecord.score),
    forecastProbability: finite(forecastRecord.probability),
    algorithmVersion: String(forecastRecord.algorithmVersion || ''),
    reviewStatus: 'auto_approved',
    reviewScore: reviewScores.length ? roundedAverage(reviewScores) : null,
    consensusCount: consensus.distinctUserCount,
    source: 'feedback-consensus',
    sourceFeedbackIds: [...consensus.feedbackIds],
    schemaVersion: 2,
    reviewedAt
  }
}

async function promoteConsensusBatch({ db, eventKey, forecastRecord } = {}) {
  if (!db || !eventKey || !forecastRecord || forecastRecord.forecastId !== eventKey) {
    return { promoted: false, ...provisionalResult() }
  }

  const feedbackCollection = db.collection('skyFeedback')
  const result = await feedbackCollection.where({ eventKey }).limit(50).get()
  const rows = authoritativeRows(Array.isArray(result.data) ? result.data : [], eventKey, forecastRecord)
  const consensus = buildConsensus(rows)
  if (!consensus.formed) return { promoted: false, ...consensus }

  const reviewedAt = db.serverDate()
  await Promise.all(consensus.feedbackIds.map((id) => feedbackCollection.doc(id).update({
    data: {
      reviewStatus: 'auto_approved',
      reviewedAt
    }
  })))

  const observation = buildObservation({ forecastRecord, consensus, rows, reviewedAt })
  await db.collection('skyObservations').doc(observationKey(forecastRecord)).set({ data: observation })
  return { promoted: true, ...consensus, observation }
}

module.exports = {
  buildConsensus,
  promotableFeedbackIds,
  promoteConsensusBatch
}
