/* Copyright (c) 2012-2014 Richard Rodger, MIT License */
"use strict";


var _    = require('underscore')
var LRU  = require( 'lru-cache' )


module.exports = function( options ) { 
  var seneca = this
  var name = 'vcache'


  options   = seneca.util.deepextend({
    prefix:  'seneca-vcache',
    maxhot: 1111,
    expires: 3600
  }, options)

  if(options.maxhot > 0) {
    var lrucache  = LRU(options.maxhot)
  }

  var cacheapi = seneca.pin({
    role:'cache',
    cmd:'*'
  })

  var cmds = {}


  var stats = {
    start: new Date().getTime(),
    set:0,
    get:0,
    vinc:0,
    vadd:0,
    vmiss:0,
    vhit:0,
    lru_hit:0,
    net_hit:0,
    lru_miss:0,
    net_miss:0,
    drop:0
  }


  function incr(ent,id,cb) {
    var vkey = options.prefix+"~v~"+ent.canon$({string:true})+'~'+id

    cacheapi.incr({key:vkey,val:1}, function(err, val){
      if(err) return cb(err, null)
      if( null != val ) { 
        stats.vinc++
        cb(null,val)
      }
      else {
        cacheapi.add( {key:vkey, val:0, expires:options.expires}, function(err){
          if(err) return cb(err, null)
          stats.vadd++
          cb(null,0)
        })
      }
    })
  }


  function setdata(ent,id,v,cb) {
    var key = options.prefix+"~d~"+v+"~"+ent.canon$({string:true})+"~"+id
    seneca.log.debug('set',key)

    if(lrucache) {
      lrucache.set( key, ent )
    }
    cacheapi.set({key:key,val:ent.data$(),expires:options.expires},function(err,out){
      stats.set++
      cb(err,out)
    })
  }




  function get(qent,id,cb) {
    var vkey = options.prefix+'~v~'+qent.canon$({string:true})+'~'+id

    cacheapi.get({key:vkey}, function(err, v){
      if(err) return cb(err, null)
      stats.get++
      //TODO: @iantocristian when is v false
      if( false === v || _.isUndefined(v) || _.isNull(v) ) {
        stats.vmiss++
        seneca.log.debug('miss','version',vkey)
        cb(null,null,0)
      }
      else {
        stats.vhit++

        var key = options.prefix+"~d~"+v+"~"+qent.canon$({string:true})+"~"+id

        if(lrucache) {
          var out = lrucache.get(key)
        }
        if( out ) {
          seneca.log.debug('hit','lru',key)
          stats.lru_hit++
          cb(null,out,v)
        }
        else {
          seneca.log.debug('miss','lru',key)
          stats.lru_miss++
          cacheapi.get({key:key},function(err, ent){
            if(err) return cb(err, null)
            if( ent ) {
              stats.net_hit++
              
              if(lrucache) {
                lrucache.set(key, ent)
              }
              
              seneca.log.debug('hit','net',key)
            }
            else {
              stats.net_miss++
              seneca.log.debug('miss','net',key)
            }
            cb(null,ent,v)
          })
        }
      }
    })
  }

  
  // vcache only works with ent.id
  function makequery(q) {
    if( _.isString(q) || _.isNumber(q) ) {
      return q
    }
    else if( q.id && 1 == _.keys(q).length ) {
      return q.id
    }
    else {
      return null
    }
  }



  cmds.save = function(args,cb) {
    var seneca = this
    this.prior(args,function(err, ent) {
      if(err) return cb(err, null)
      
      incr(ent,ent.id,function(err, v){
        if(err) return cb(err, null)
        setdata(ent,ent.id,v,function(err){
          if(err) return cb(err, null)
          seneca.log.debug('set',ent,ent.id,v)
          cb(null,ent)
        })
      })
    })
  }


  cmds.load = function(args,cb) {
    var seneca = this
    var prior = this.prior
    var qent = args.qent
    var q    = args.q

    var id = makequery(q)

    if( null == id ) {
      return prior(args,cb)
    }

    get(qent,id,function(err, out,v){
      if(err) {
        return cb(err, null)
      }
      else if( out ) {
        var ent = qent.make$(out)
        cb(null,ent)
      }
      else {
        seneca.log.debug('miss',qent,id,v)
        prior(args,function(err, ent){
          if( ent ) {
            setdata(ent,ent.id,v,er(function(){
              cb(null,ent)
            }))
          }
          else {
            cb(err,null)
          }
        })
      }
    })
  }


  cmds.list = function(args,cb) {
    var prior = this.prior
    var qent = args.qent
    var q    = args.q

    prior(args,cb)
  }


  cmds.remove = function(args,cb) {
    var prior = this.prior
    var qent = args.qent
    var q    = args.q

    prior(args,function(err, ent){
      if(err) cb(err, null)
      var id = makequery(q)
      if( null == id ) {
        return cb(null,ent)
      }

      var vkey = options.prefix+"~v~"+qent.canon$({string:true})+'~'+id
      cacheapi.set({key:vkey,val:-1,expires:options.expires},function(err){
        if(err) cb(err, null)
        stats.drop++
        seneca.log.debug('drop',vkey)
        cb(null,ent)
      })
    })
  }


  function reghandlers(args) {
    seneca.add(_.extend({role: 'entity', cmd: 'save'}, args), cmds.save)
    seneca.add(_.extend({role: 'entity', cmd: 'load'}, args), cmds.load)
    seneca.add(_.extend({role: 'entity', cmd: 'list'}, args), cmds.list)
    seneca.add(_.extend({role: 'entity', cmd: 'remove'}, args), cmds.remove)
  }


  if (options.entities) {
    _.each(options.entities, function(entspec) {
      reghandlers(_.isString(entspec) ? seneca.util.parsecanon(entspec) : entspec);
    })
  }
  else {
    reghandlers();
  }


  seneca.add({plugin:'vcache',cmd:'stats'},function(args,done){
    var out = _.clone(stats)
    
    if(lrucache) {
      out.hotsize = lrucache.keys().length
    } else {
      out.hotsize = 0
    }
    out.end = new Date().getTime()
    seneca.log.debug('stats',out)
    done(null,out)
  })


  return {
    name:name
  }
}

