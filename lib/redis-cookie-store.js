const Debug = require("debug")

const DebugCreatedKeeper = new Map()

const deasync = require("deasync")
const tough = require("tough-cookie")

const debug = key => {
  if (!DebugCreatedKeeper.has(key)) {
    DebugCreatedKeeper.set(key, Debug(key))
  }
  return DebugCreatedKeeper.get(key)
}

const { Store, permuteDomain, pathMatch } = tough

function matchAll(domainIndex) {
  const results = []
  Object.keys(domainIndex).forEach(curPath => {
    const pathIndex = domainIndex[curPath]
    Object.keys(pathIndex).forEach(key => {
      results.push(pathIndex[key])
    })
  })
  return results
}

function matchRFC(domainIndex, path) {
  const results = []
  // NOTE: we should use path-match algorithm from S5.1.4 here
  // (see : https://github.com/ChromiumWebApps/chromium/blob/b3d3b4da8bb94c1b2e061600df106d590fda3620/net/cookies/canonical_cookie.cc#L299)
  Object.keys(domainIndex).forEach(cookiePath => {
    if (pathMatch(path, cookiePath)) {
      const pathIndex = domainIndex[cookiePath]
      Object.keys(pathIndex).forEach(key => {
        results.push(pathIndex[key])
      })
    }
  })
  return results
}

class RedisCookieStore extends Store {
  constructor({ redis, key: id }) {
    super()
    this.redis = redis
    this.idx = {} // idx is memory cache
    this.id = id || "cookie"
    this.synchronous = true

    this.load((err, idx) => {
      if (err) throw err
      if (idx) {
        this.idx = idx
      }
      this.initialized = true
    })
    while (!this.initialized) {
      debug("redis-cookie-store:load")("init..")
      deasync.sleep(50)
    }
    debug("redis-cookie-store:load")("initialized")
  }

  load(next) {
    debug("redis-cookie-store:load")("call")
    this.redis.get(this.id, (err, data) => {
      if (err) return next(err)
      if (!data) return next()
      const cookies = data ? JSON.parse(data) : null
      const domains = Object.keys(cookies)
      domains.forEach(domain => {
        const paths = Object.keys(cookies[domain])
        paths.forEach(path => {
          const keys = Object.keys(cookies[domain][path])
          keys.forEach(key => {
            if (key !== null) {
              cookies[domain][path][key] = tough.fromJSON(
                JSON.stringify(cookies[domain][path][key]),
              )
            }
          })
        })
      })
      debug("redis-cookie-store:load")("end")
      return next(null, cookies)
    })
  }

  save(next) {
    const cookie = JSON.stringify(this.idx)
    this.redis.set(this.id, cookie, next)
  }

  findCookie(domain, path, key, next) {
    if (
      !this.idx[domain] ||
      !this.idx[domain][path] ||
      !this.idx[domain][path][key]
    ) {
      debug("redis-cookie-store:findCookie")("no-cookie to", domain, path, key)
      return next(null, undefined)
    }
    const cookie = this.idx[domain][path][key]
    debug("redis-cookie-store:findCookie")(
      "cookie",
      cookie,
      "to",
      domain,
      path,
      key,
    )
    return next(null, cookie)
  }

  findCookies(domain, path, next) {
    debug("redis-cookie-store:findCookies")("domain", domain)
    debug("redis-cookie-store:findCookies")("path", path)

    let results = []

    if (!domain) {
      debug("redis-cookie-store:findCookies")("no-cookie to", domain)
      return next(null, [])
    }

    let pathMatcher

    if (!path) {
      // null means "all paths"
      debug("redis-cookie-store:findCookies")("null path to", domain, path)
      pathMatcher = matchAll
    } else {
      debug("redis-cookie-store:findCookies")("not null path to", domain, path)
      pathMatcher = matchRFC
    }

    const domains = permuteDomain(domain) || [domain]
    debug("redis-cookie-store:findCookies")("domains", domains)
    const { idx } = this
    domains.forEach(curDomain => {
      const domainIndex = idx[curDomain]
      if (!domainIndex) {
        debug("redis-cookie-store:findCookies")("no domain index", domain)
        return
      }
      debug("redis-cookie-store:findCookies")(
        "domain index",
        domainIndex,
        "on",
        domain,
        path,
      )
      results = [...pathMatcher(domainIndex, path)]
    })

    debug("redis-cookie-store:findCookies")("results", results)
    return next(null, results)
  }

  putCookie(cookie, next) {
    if (!this.idx[cookie.domain]) {
      this.idx[cookie.domain] = {}
    }
    if (!this.idx[cookie.domain][cookie.path]) {
      this.idx[cookie.domain][cookie.path] = {}
    }
    debug("redis-cookie-store:putCookie")("cookie", cookie)
    this.idx[cookie.domain][cookie.path][cookie.key] = cookie
    this.save(() => {
      next(null)
    })
  }

  updateCookie(oldCookie, newCookie, next) {
    // updateCookie() may avoid updating cookies that are identical.  For example,
    // lastAccessed may not be important to some stores and an equality
    // comparison could exclude that field.
    debug("redis-cookie-store:updateCookie")("oldCookie", oldCookie)
    debug("redis-cookie-store:updateCookie")("newCookie", newCookie)
    this.putCookie(newCookie, next)
  }

  removeCookie(domain, path, key, next) {
    debug("redis-cookie-store:removeCookie")(
      "remove cookie on",
      domain,
      path,
      key,
    )
    if (
      this.idx[domain] &&
      this.idx[domain][path] &&
      this.idx[domain][path][key]
    ) {
      delete this.idx[domain][path][key]
    }
    this.save(() => {
      next(null)
    })
  }

  removeCookies(domain, path, next) {
    debug("redis-cookie-store:removeCookies")("remove cookies on", domain, path)
    if (this.idx[domain]) {
      if (path) {
        delete this.idx[domain][path]
      } else {
        delete this.idx[domain]
      }
    }
    this.save(() => {
      next(null)
    })
  }

  getAllCookies(next) {
    debug("redis-cookie-store:getAllCookies")("get all cookies")
    const cookies = []
    const { idx } = this

    const domains = Object.keys(idx)
    domains.forEach(domain => {
      const paths = Object.keys(idx[domain])
      paths.forEach(path => {
        const keys = Object.keys(idx[domain][path])
        keys.forEach(key => {
          if (key !== null) {
            cookies.push(idx[domain][path][key])
          }
        })
      })
    })

    // Sort by creationIndex so deserializing retains the creation order.
    // When implementing your own store, this SHOULD retain the order too
    cookies.sort((a, b) => (a.creationIndex || 0) - (b.creationIndex || 0))

    next(null, cookies)
  }
}

module.exports = RedisCookieStore
