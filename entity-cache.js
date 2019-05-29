/* Copyright © 2012-2019 Richard Rodger and other contributors, MIT License. */
'use strict'

var LRUCache = require('lru-cache')

module.exports = entity_cache
module.exports.defaults = {
  prefix: 'seneca-entity',
  maxhot: 1111,
  expires: 3600 // 1 Hour
}

function entity_cache(options) {
  var seneca = this

  // Setup in-memory cache

  // NOTE: never used for versionKeys - these must always sync against
  // remote cache
  var hotcache = new LRUCache(options.maxhot)

  // Statistics

  var stats = {
    start: Date.now(),
    set: 0,
    get: 0,
    vinc: 0,
    vadd: 0,
    vmiss: 0,
    vhit: 0,
    hot_hit: 0,
    net_hit: 0,
    hot_miss: 0,
    net_miss: 0,
    drop: 0,
    cache_errs: 0
  }

  seneca.add('plugin:entity-cache,get:stats', get_stats)
  seneca.add('plugin:entity-cache,list:hot-keys', list_hot_keys)

  // Keys

  var versionKey = function(ent, id) {
    // Example: 'seneca-vcache~v~zen/moon/bar~171qa9'

    var key = options.prefix + '~v~' + ent.canon$({ string: true }) + '~' + id
    return key
  }

  var dataKey = function(ent, id, version) {
    // Example: 'seneca-vcache~d~0~zen/moon/bar~171qa9'

    var key =
      options.prefix +
      '~d~' +
      version +
      '~' +
      ent.canon$({ string: true }) +
      '~' +
      id
    return key
  }

  // Cache write

  var writeKey = function(seneca, vkey, reply) {
    // New item

    var item = {
      key: vkey,
      val: 1,
      expires: options.expires
    }

    seneca.act({ role: 'cache', cmd: 'set' }, item, function(err) {
      if (err) {
        ++stats.cache_errs
        return reply(err)
      }

      ++stats.vadd
      return reply()
    })
  }

  var writeData = function(seneca, ent, version, reply) {
    var key = dataKey(ent, ent.id, version)
    seneca.log.debug('set', key)

    hotcache.set(key, ent.data$())
    seneca.act(
      { role: 'cache', cmd: 'set' },
      { key: key, val: ent.data$(), expires: options.expires },
      function(err, result) {
        var key = result && result.value

        if (err) {
          ++stats.cache_errs
          return reply(err)
        }

        ++stats.set
        return reply(key)
      }
    )
  }

  var save_action = function entity_cache_save(msg, reply) {
    var self = this
    var save_prior = this.prior

    // Pass to lower priority entity action first

    save_prior.call(self, msg, function(err, ent) {
      if (err) {
        return reply(err)
      }

      // Generate version key

      var vkey = versionKey(ent, ent.id)

      self.act({ role: 'cache', cmd: 'incr' }, { key: vkey, val: 1 }, function(
        err,
        result
      ) {
        var version = result && result.value

        // console.log('RESULT', vkey, result)

        if (err) {
          ++stats.cache_errs
          return reply(err)
        }

        if (version === false) {
          // New item

          writeKey(self, vkey, function(err) {
            if (err) {
              return reply(err)
            }

            writeData(self, ent, 1, function(err) {
              reply(err || ent)
            })
          })

          return
        }

        // Updated item

        ++stats.vinc
        writeData(self, ent, version, function(err) {
          reply(err || ent)
        })
      })
    })
  }

  // Cache read

  var load_action = function entity_cache_load(msg, reply) {
    var self = this
    var load_prior = this.prior
    var qent = msg.qent

    // Verify id format is compatible

    if (!msg.q.id || Object.keys(msg.q).length !== 1) {
      return load_prior.call(self, msg, reply)
    }

    var id = msg.q.id

    // Lookup version key

    var vkey = versionKey(qent, id)
    this.act({ role: 'cache', cmd: 'get' }, { key: vkey }, function(
      err,
      result
    ) {
      var version = result && result.value

      if (err) {
        ++stats.cache_errs
        return reply(err)
      }

      ++stats.get

      // Version not found

      if (null == version || version === -1) {
        // Item dropped from cache

        ++stats.vmiss
        self.log.debug('miss', 'version', vkey)
        self.log.debug('miss', qent, id, 0)

        // Pass to lower priority handler

        return load_prior.call(self, msg, function(err, ent) {
          if (err || !ent) {
            // Error or not found
            return reply(err)
          }

          writeKey(self, vkey, function(err) {
            if (err) {
              return reply(err)
            }

            return writeData(self, ent, 1, function(err) {
              return reply(err || ent)
            })
          })
        })
      }

      // Version found

      ++stats.vhit
      var key = dataKey(qent, id, version)
      var record = hotcache.get(key)
      if (record) {
        // Entry found (hotcache)

        self.log.debug('hit', 'hot', key)
        ++stats.hot_hit
        return reply(qent.make$(record))
      }

      // Entry not found (evicted from hotcache)

      self.log.debug('miss', 'hot', key)
      ++stats.hot_miss

      self.act({ role: 'cache', cmd: 'get' }, { key: key }, function(
        err,
        result
      ) {
        var ent_data = result && result.value

        if (err) {
          ++stats.cache_errs
          return reply(err)
        }

        // Entry found (upstream)

        if (ent_data) {
          ++stats.net_hit
          hotcache.set(key, ent_data)
          self.log.debug('hit', 'net', key)
          return reply(qent.make$(ent_data))
        }

        // Not found (upstream)

        ++stats.net_miss
        self.log.debug('miss', 'net', key)
        return load_prior.call(self, msg, function(err, ent) {
          if (err || !ent) {
            // Error or not found
            return reply(err)
          }
          return writeData(self, ent, version, function(err) {
            return reply(err || ent)
          })
        })
      })
    })
  }

  // Cache remove

  var remove_action = function entity_cache_remove(msg, reply) {
    var self = this
    var remove_prior = this.prior

    remove_prior.call(self, msg, function(err, remove_ent) {
      if (err) {
        return reply(err)
      }

      var vkey = versionKey(msg.qent, msg.q.id) // Only called with a valid entity id
      self.act(
        { role: 'cache', cmd: 'set' },
        { key: vkey, val: -1, expires: options.expires },
        function(err) {
          if (err) {
            ++stats.cache_errs
            return reply(err)
          }

          ++stats.drop
          self.log.debug('drop', vkey)
          return reply(remove_ent)
        }
      )
    })
  }

  // Cache list

  /* NOTE: NOT IMPLEMENTED (YET)
  var list = function vcache_list(msg, reply) {
    // Pass-through to underlying cache
    var self = this
    var list_prior = this.prior

    return list_prior.call(self, msg, reply)
  }
  */

  // Register cache interface

  var registerHandlers = function(msg, flags) {
    if (flags.exact) {
      seneca.add({ ...msg, role: 'entity', cmd: 'save' }, save_action)
      seneca.add({ ...msg, role: 'entity', cmd: 'load' }, load_action)
      // seneca.add({...msg, role: 'entity', cmd: 'list' }, list)
      seneca.add({ ...msg, role: 'entity', cmd: 'remove' }, remove_action)
      return
    }

    var actions = {
      save: save_action,
      load: load_action,
      //list: list,
      remove: remove_action
    }

    var core_patterns = [
      { role: 'entity', cmd: 'save' },
      { role: 'entity', cmd: 'load' },
      //{ role: 'entity', cmd: 'list' },
      { role: 'entity', cmd: 'remove' }
    ]

    core_patterns.forEach(function(core_pat) {
      var pats = seneca.list(core_pat)
      pats.forEach(function(pat) {
        seneca.add(pat, actions[core_pat.cmd])
      })
    })
  }

  if (options.entities) {
    options.entities.forEach(function(entspec) {
      registerHandlers(
        'string' === typeof entspec ? seneca.util.parsecanon(entspec) : entspec,
        { exact: true }
      )
    })
  } else {
    registerHandlers(null, { exact: false })
  }

  // Register cache statistics action

  function get_stats(msg, reply) {
    var result = { ...stats }
    result.hotsize = hotcache.length
    result.end = Date.now()
    this.log.debug('stats', result)
    return reply(result)
  }

  function list_hot_keys(msg, reply) {
    reply({ keys: hotcache.keys() })
  }

  return { name: 'vcache' }
}
