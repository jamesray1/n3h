const Sqlite = require('better-sqlite3')

const path = require('path')
const fs = require('fs')

class DebugSnapshotState {
  constructor (file) {
    this._db = new Sqlite(file)

    // make sure we use the fast disk write method
    this._db.pragma('journal_mode = WAL')

    this._db.prepare(`CREATE TABLE IF NOT EXISTS cas (
      hash TEXT PRIMARY KEY UNIQUE NOT NULL,
      value TEXT NOT NULL
    )`).run()

    this._db.prepare(`CREATE TABLE IF NOT EXISTS log (
      epoch_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      entry TEXT NOT NULL
    )`).run()

    this._db.prepare(`CREATE INDEX IF NOT EXISTS log_epoch_ms_idx
      ON log (epoch_ms)`)

    this._casInsert = this._db.prepare(`INSERT OR IGNORE INTO cas (
      hash, value
    ) VALUES (?, ?)`)

    this._logInsert = this._db.prepare(`INSERT INTO log (
      epoch_ms, type, entry
    ) VALUES (?, ?, ?)`)

    this.insert = this._db.transaction((...args) => {
      this._insert(...args)
    })

    this._casSelectAll = this._db.prepare(`SELECT * from cas`)
    this._logSelectAll = this._db.prepare(`SELECT * from log ORDER BY epoch_ms, rowid`)

    this._checkpointTimer = setInterval(() => {
      this._db.checkpoint()
    }, 10000)
  }

  destroy () {
    clearInterval(this._checkpointTimer)
    this._checkpointTimer = null

    this._casInsert = null
    this._logInsert = null
    this.insert = null
    this._casSelectAll = null
    this._logSelectAll = null

    this._db.close()
    this._db = null
  }

  dump () {
    const cas = this._casSelectAll.all()
    const casMap = {}
    for (let e of cas) {
      casMap[e.hash] = e.value
    }

    const log = this._logSelectAll.all()

    const out = []

    for (let e of log) {
      out.push(`-- ${e.type} - ${(new Date(e.epoch_ms)).toISOString()} --`)
      const entry = JSON.parse(e.entry)
      for (let k in entry) {
        if (k.startsWith('$cas$')) {
          if (entry[k] in casMap) {
            entry[k] = JSON.parse(casMap[entry[k]])
          } else {
            entry[k] = '[not found] ' + entry[k]
          }
        }
      }
      out.push(JSON.stringify(entry, null, 2))
    }

    return out.join('\n')
  }

  // -- private -- //

  _insert (casMap, logType, logEntry) {
    for (let hash in casMap) {
      this._casInsert.run(hash, JSON.stringify(
        casMap[hash], null, 2))
    }
    this._logInsert.run(Date.now(), logType, JSON.stringify(
      logEntry, null, 2))
  }
}

exports.DebugSnapshotState = DebugSnapshotState

let SINGLETON = null

exports.getDebugSnapshot = function getDebugSnapshot () {
  if (!SINGLETON) {
    // first, clear out any old debug snapshot logs
    for (let file of fs.readdirSync('.')) {
      if (file.startsWith('n3h-debug-snapshot-state-')) {
        try {
          fs.unlinkSync(file)
        } catch (e) { /* pass */ }
      }
    }

    SINGLETON = new DebugSnapshotState(`n3h-debug-snapshot-state-${Date.now()}.sqlite3`)
  }
  return SINGLETON
}