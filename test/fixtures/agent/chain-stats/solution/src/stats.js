function mean(xs) {
  let total = 0
  for (let i = 0; i < xs.length; i++) total += xs[i]
  return total / xs.length
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

module.exports = { mean, median }
