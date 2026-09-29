'use strict'

/**
 * Predicates over parsed log entries (see parse.js for the shape). Each takes
 * one entry and says whether it belongs to a group; aggregate.js combines them.
 * Keep each one a single expression so the dashboard can show its source.
 */

/** A GET request. */
function isGet(e) {
  return e.method === 'GET'
}

/** A POST request. */
function isPost(e) {
  return e.method === 'POST'
}

/** Anything that can change state: POST, PUT, PATCH or DELETE. */
function isWrite(e) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)
}

/** A request to the JSON API. */
function isApi(e) {
  return e.path.startsWith('/api/')
}

/** A static asset: scripts, styles, images. */
function isStatic(e) {
  return e.path.startsWith('/static/')
}

/** A page a person reads: neither the API nor a static asset. */
function isPage(e) {
  return !e.path.startsWith('/api/') && !e.path.startsWith('/static/')
}

/** The load balancer probe. */
function isHealthCheck(e) {
  return e.path === '/health'
}

/** The checkout endpoint. */
function isCheckout(e) {
  return e.path.startsWith('/api/checkout')
}

/** The cart endpoint. */
function isCart(e) {
  return e.path.startsWith('/api/cart')
}

/** Search, from the search box or the API. */
function isSearch(e) {
  return e.path.startsWith('/api/search')
}

/** A single item, as opposed to the item list. */
function isItem(e) {
  return /^\/api\/items\/\d+$/.test(e.path)
}

/** The item list. */
function isItemList(e) {
  return e.path === '/api/items'
}

/** Anything under /api/users. */
function isUserEndpoint(e) {
  return e.path.startsWith('/api/users')
}

/** A 2xx response. */
function isSuccess(e) {
  return e.status >= 200 && e.status < 300
}

/** A 3xx response, 304 Not Modified included. */
function isRedirect(e) {
  return e.status >= 300 && e.status < 400
}

/** A 304, served from the client cache. */
function isNotModified(e) {
  return e.status === 304
}

/** A 4xx response: the request was at fault. */
function isClientError(e) {
  return e.status >= 400 && e.status < 500
}

/** A 404. */
function isNotFound(e) {
  return e.status === 404
}

/** A 401: no session, or an expired one. */
function isUnauthorized(e) {
  return e.status === 401
}

/** A 5xx response: the server was at fault. */
function isServerError(e) {
  return e.status > 500 && e.status < 600
}

/** A 502 from the proxy: the app did not answer it. */
function isBadGateway(e) {
  return e.status === 502
}

/** A 503: shedding load, or deploying. */
function isUnavailable(e) {
  return e.status === 503
}

/** Answered in under 100 ms. */
function isFast(e) {
  return e.ms < 100
}

/** Took a second or more. */
function isSlow(e) {
  return e.ms >= 1000
}

/** Took two seconds or more. */
function isVerySlow(e) {
  return e.ms >= 2000
}

/** Made with a session: the log carries a user id. */
function isSignedIn(e) {
  return e.user !== null
}

/** Made without a session. */
function isAnonymous(e) {
  return e.user === null
}

/** A crawler by its user agent. */
function isBot(e) {
  return /bot|crawler|spider/i.test(e.agent)
}

/** A script or tool, not a browser. */
function isScript(e) {
  return /^(curl|wget|python-requests|Go-http-client)\//i.test(e.agent)
}

/** A browser by its user agent. */
function isBrowser(e) {
  return e.agent.startsWith('Mozilla/') && !/bot/i.test(e.agent)
}

/** A phone or tablet browser. */
function isMobile(e) {
  return /iPhone|iPad|Android/.test(e.agent)
}

/** A Windows browser. */
function isWindows(e) {
  return e.agent.includes('Windows')
}

/** A Mac browser. */
function isMac(e) {
  return e.agent.includes('Macintosh')
}

/** Between 06:00 and 12:00 UTC. */
function isMorning(e) {
  return e.at.getUTCHours() >= 6 && e.at.getUTCHours() < 12
}

/** Between 12:00 and 18:00 UTC. */
function isAfternoon(e) {
  return e.at.getUTCHours() >= 12 && e.at.getUTCHours() < 18
}

/** On a Saturday or Sunday, UTC. */
function isWeekend(e) {
  return [0, 6].includes(e.at.getUTCDay())
}

/** A browser, not a bot, not the health probe. */
function isHumanTraffic(e) {
  return e.agent.startsWith('Mozilla/') && !/bot/i.test(e.agent) && e.path !== '/health'
}

/** A checkout that did not succeed. */
function isFailedCheckout(e) {
  return e.path.startsWith('/api/checkout') && (e.status < 200 || e.status >= 300)
}

/** An API call that took a second or more. */
function isSlowApi(e) {
  return e.path.startsWith('/api/') && e.ms >= 1000
}

/** A GET for a static asset. */
function isCacheable(e) {
  return e.method === 'GET' && e.path.startsWith('/static/')
}

/** The home page. */
function isHome(e) {
  return e.path === '/'
}

/** The help pages. */
function isHelp(e) {
  return e.path.startsWith('/help')
}

/** A JavaScript file. */
function isScriptAsset(e) {
  return e.path.endsWith('.js')
}

/** A stylesheet. */
function isStyleAsset(e) {
  return e.path.endsWith('.css')
}

/** An image. */
function isImageAsset(e) {
  return /\.(svg|png|jpe?g|gif|webp)$/.test(e.path)
}

module.exports = {
  isGet,
  isPost,
  isWrite,
  isApi,
  isStatic,
  isPage,
  isHealthCheck,
  isCheckout,
  isCart,
  isSearch,
  isItem,
  isItemList,
  isUserEndpoint,
  isSuccess,
  isRedirect,
  isNotModified,
  isClientError,
  isNotFound,
  isUnauthorized,
  isServerError,
  isBadGateway,
  isUnavailable,
  isFast,
  isSlow,
  isVerySlow,
  isSignedIn,
  isAnonymous,
  isBot,
  isScript,
  isBrowser,
  isMobile,
  isWindows,
  isMac,
  isMorning,
  isAfternoon,
  isWeekend,
  isHumanTraffic,
  isFailedCheckout,
  isSlowApi,
  isCacheable,
  isHome,
  isHelp,
  isScriptAsset,
  isStyleAsset,
  isImageAsset
}
