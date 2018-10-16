const libp2p = require('libp2p')
const Tcp = require('libp2p-tcp')
const Mplex = require('libp2p-mplex')
const KadDht = require('libp2p-kad-dht')
const defaultsDeep = require('@nodeutils/defaults-deep')
const pull = require('pull-stream/pull')
const msgpack = require('msgpack-lite')
const PeerId = require('peer-id')

const { $p, $sleep, AsyncClass } = require('n3h-common')

class RawLibP2p extends libp2p {
  constructor (_options) {
    const defaults = {
      modules: {
        transport: [ Tcp ],
        streamMuxer: [ Mplex ],
        dht: KadDht
      },
      config: {
        dht: {
          kBucketSize: 20
        },
        EXPERIMENTAL: {
          dht: true
        }
      }
    }

    super(defaultsDeep(_options, defaults))
  }
}

/**
 */
class LibP2pBundle extends AsyncClass {
  /**
   */
  async init (opts) {
    await super.init()

    this._node = new RawLibP2p(opts)

    this._peerCache = new Map()

    this.$pushDestructor(async () => {
      this._peerCache.clear()
      this._peerCache = null
      this._node._dht.randomWalk.stop()
      await $p(this._node.stop.bind(this._node))
      this._node = null
    })

    this._node.handle('/holomsg/0.0.1', async (protocol, conn) => {
      const remotePeerId = await this._cachePeerFromConn(conn)
      pull(conn, makeSink(async (data) => {
        const query = msgpack.decode(data)
        switch (query.type) {
          case 'ping':
            console.log('got ping, sending pong')
            pull(makeGen(msgpack.encode({
              type: 'pong',
              originTime: query.now,
              srvTime: Date.now()
            })), conn)
            break
          case 'send':
            const result = await new Promise((resolve, reject) => {
              this.emit('handleSend', {
                from: remotePeerId,
                data: query.data,
                resolve,
                reject
              })
            })
            pull(makeGen(msgpack.encode(result)), conn)
            break
          default:
            console.error('bad msg type', query.type)
            process.exit(1)
        }
      }))
    })

    this._node.on('peer:connect', async (peer) => {
      console.log('new peer', peer.id.toB58String())

      // side effect: adds this to our peer cache
      const result = msgpack.decode(await this._p2pSend(
        peer.id.toB58String(), msgpack.encode({
          type: 'ping',
          now: Date.now()
        })))

      console.log(' -- ping round trip -- ' + (
        Date.now() - result.originTime) + ' ms')
    })

    this._node.on('peer:disconnect', (peer) => {
      peer = peer.id.toB58String()
      console.log('lost peer', peer)
      this._peerCache.delete(peer)
    })

    await $p(this._node.start.bind(this._node))

    this._node._dht.randomWalk.start(1, 5000, 10000)
  }

  /**
   */
  getId () {
    return this._node.peerInfo.id.toB58String()
  }

  /**
   */
  getBindings () {
    return this._node.peerInfo.multiaddrs.toArray().map(
      a => a.toString())
  }

  /**
   */
  async connect (multiaddr) {
    await $p(this._node.dial.bind(this._node, multiaddr))
  }

  /**
   */
  async send (id, message) {
    return msgpack.decode(await this._p2pSend(id, msgpack.encode({
      type: 'send',
      data: message
    })))
  }

  // -- private -- //

  /**
   */
  async _cachePeerFromConn (conn) {
    const peer = await $p(conn.getPeerInfo.bind(conn))
    this._peerCache.set(peer.id.toB58String(), peer)
    return peer.id.toB58String()
  }

  /**
   */
  async _fetchPeer (peerId) {
    const pr = this._node.peerRouting
    const lookFor = PeerId.createFromB58String(peerId)
    const start = Date.now()
    let peer = null
    let waitTime = 1
    while (!peer && Date.now() - start < 5000) {
      try {
        if (this._peerCache.has(peerId)) {
          return this._peerCache.get(peerId)
        }
        peer = await $p(pr.findPeer.bind(pr, lookFor))
      } catch (e) {
        peer = null
        await $sleep(waitTime)
        waitTime *= 2
        if (waitTime > 200) {
          waitTime = 200
        }
      }
    }
    if (!peer) {
      console.error('giving up finding peer')
      throw new Error('could not find peer')
    }
    console.log('found peer in', Date.now() - start, 'ms')
    if (peer.id.toB58String() !== peerId) {
      throw new Error('wtf')
    }
    this._peerCache.set(peerId, peer)
    return peer
  }

  /**
   */
  async _p2pSend (toAddress, data) {
    try {
      const peer = await this._fetchPeer(toAddress)

      const result = await new Promise(async (resolve, reject) => {
        const conn = await $p(this._node.dialProtocol.bind(this._node, peer, '/holomsg/0.0.1'))
        pull(makeGen(data), conn)
        pull(conn, makeSink((data) => {
          resolve(data)
        }))
      })
      return result
    } catch (e) {
      console.error(e)
      process.exit(1)
    }
  }
}

exports.LibP2pBundle = LibP2pBundle

/**
 */
function makeGen (data) {
  let sent = false
  return (end, fn) => {
    if (end) return fn(end)
    if (sent) {
      fn(true)
    } else {
      sent = true
      fn(null, data)
    }
  }
}

/**
 */
function makeSink (fn) {
  return (read) => {
    let data = Buffer.alloc(0)
    const next = (end, chunk) => {
      if (end === true) {
        fn(data)
        return
      }
      if (end) throw end
      data = Buffer.concat([data, chunk])
      setImmediate(() => {
        read(null, next)
      })
    }
    read(null, next)
  }
}
