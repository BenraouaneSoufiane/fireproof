import { create, load } from 'prolly-trees/db-index'
// import { create, load } from '../../../../prolly-trees/src/db-index.js'

import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { nocache as cache } from 'prolly-trees/cache'
import { bf, simpleCompare } from 'prolly-trees/utils'
import { makeGetBlock } from './prolly.js'
import { cidsToProof } from './fireproof.js'

import * as codec from '@ipld/dag-cbor'
// import { create as createBlock } from 'multiformats/block'
import { TransactionBlockstore, doTransaction } from './blockstore.js'
import charwise from 'charwise'

const ALWAYS_REBUILD = false // todo: make false

const compare = (a, b) => {
  const [aKey, aRef] = a
  const [bKey, bRef] = b
  const comp = simpleCompare(aKey, bKey)
  if (comp !== 0) return comp
  return refCompare(aRef, bRef)
}

const refCompare = (aRef, bRef) => {
  if (Number.isNaN(aRef)) return -1
  if (Number.isNaN(bRef)) throw new Error('ref may not be Infinity or NaN')
  if (aRef === Infinity) return 1 // need to test this on equal docids!
  // if (!Number.isFinite(bRef)) throw new Error('ref may not be Infinity or NaN')
  return simpleCompare(aRef, bRef)
}

const dbIndexOpts = { cache, chunker: bf(3), codec, hasher, compare }
const idIndexOpts = { cache, chunker: bf(3), codec, hasher, compare: simpleCompare }

const makeDoc = ({ key, value }) => ({ _id: key, ...value })

/**
 * JDoc for the result row type.
 * @typedef {Object} ChangeEvent
 * @property {string} key - The key of the document.
 * @property {Object} value - The new value of the document.
 * @property {boolean} [del] - Is the row deleted?
 * @memberof DbIndex
 */

/**
 * JDoc for the result row type.
 * @typedef {Object} DbIndexEntry
 * @property {string[]} key - The key for the DbIndex entry.
 * @property {Object} value - The value of the document.
 * @property {boolean} [del] - Is the row deleted?
 * @memberof DbIndex
 */

/**
 * Transforms a set of changes to DbIndex entries using a map function.
 *
 * @param {ChangeEvent[]} changes
 * @param {Function} mapFn
 * @returns {DbIndexEntry[]} The DbIndex entries generated by the map function.
 * @private
 * @memberof DbIndex
 */
const indexEntriesForChanges = (changes, mapFn) => {
  const indexEntries = []
  changes.forEach(({ key, value, del }) => {
    if (del || !value) return
    mapFn(makeDoc({ key, value }), (k, v) => {
      if (typeof v === 'undefined' || typeof k === 'undefined') return
      indexEntries.push({
        key: [charwise.encode(k), key],
        value: v
      })
    })
  })
  return indexEntries
}

/**
 * Represents an DbIndex for a Fireproof database.
 *
 * @class DbIndex
 * @classdesc An DbIndex can be used to order and filter the documents in a Fireproof database.
 *
 * @param {Fireproof} database - The Fireproof database instance to DbIndex.
 * @param {Function} mapFn - The map function to apply to each entry in the database.
 *
 */
export class DbIndex {
  constructor (database, mapFn, clock, opts = {}) {
    // console.log('DbIndex constructor', database.constructor.name, typeof mapFn, clock)
    /**
     * The database instance to DbIndex.
     * @type {Fireproof}
     */
    this.database = database
    if (!database.indexBlocks) {
      database.indexBlocks = new TransactionBlockstore(database.name + '.indexes', database.blocks.valet.getKeyMaterial())
    }
    /**
     * The map function to apply to each entry in the database.
     * @type {Function}
     */

    if (typeof mapFn === 'string') {
      this.mapFnString = mapFn
    } else {
      this.mapFn = mapFn
      this.mapFnString = mapFn.toString()
    }
    this.name = opts.name || this.makeName()
    this.indexById = { root: null, cid: null }
    this.indexByKey = { root: null, cid: null }
    this.dbHead = null
    if (clock) {
      this.indexById.cid = clock.byId
      this.indexByKey.cid = clock.byKey
      this.dbHead = clock.db
    }
    this.instanceId = this.database.instanceId + `.DbIndex.${Math.random().toString(36).substring(2, 7)}`
    this.updateIndexPromise = null
    if (!opts.temporary) { DbIndex.registerWithDatabase(this, this.database) }
  }

  makeName () {
    const regex = /\(([^,()]+,\s*[^,()]+|\[[^\]]+\],\s*[^,()]+)\)/g
    const matches = Array.from(this.mapFnString.matchAll(regex), match => match[1].trim())
    return matches[1]
  }

  static registerWithDatabase (inIndex, database) {
    if (!database.indexes.has(inIndex.mapFnString)) {
      database.indexes.set(inIndex.mapFnString, inIndex)
    } else {
      // merge our inIndex code with the inIndex clock or vice versa
      const existingIndex = database.indexes.get(inIndex.mapFnString)
      // keep the code instance, discard the clock instance
      if (existingIndex.mapFn) { // this one also has other config
        existingIndex.dbHead = inIndex.dbHead
        existingIndex.indexById.cid = inIndex.indexById.cid
        existingIndex.indexByKey.cid = inIndex.indexByKey.cid
      } else {
        inIndex.dbHead = existingIndex.dbHead
        inIndex.indexById.cid = existingIndex.indexById.cid
        inIndex.indexByKey.cid = existingIndex.indexByKey.cid
        database.indexes.set(inIndex.mapFnString, inIndex)
      }
    }
  }

  toJSON () {
    const indexJson = { name: this.name, code: this.mapFnString, clock: { db: null, byId: null, byKey: null } }
    indexJson.clock.db = this.dbHead?.map(cid => cid.toString())
    indexJson.clock.byId = this.indexById.cid?.toString()
    indexJson.clock.byKey = this.indexByKey.cid?.toString()
    return indexJson
  }

  static fromJSON (database, { code, clock, name }) {
    // console.log('DbIndex.fromJSON', database.constructor.name, code, clock)
    return new DbIndex(database, code, clock, { name })
  }

  /**
   * JSDoc for Query type.
   * @typedef {Object} DbQuery
   * @property {string[]} [range] - The range to query.
   * @memberof DbIndex
   */

  /**
   * Query object can have {range}
   * @param {DbQuery} query - the query range to use
   * @returns {Promise<{rows: Array<{id: string, key: string, value: any}>}>}
   * @memberof DbIndex
   * @instance
   */
  async query (query, update = true) {
    // const callId = Math.random().toString(36).substring(2, 7)
    // todo pass a root to query a snapshot
    // console.time(callId + '.updateIndex')
    update && await this.updateIndex(this.database.indexBlocks)
    // console.timeEnd(callId + '.updateIndex')
    // console.time(callId + '.doIndexQuery')
    // console.log('query', query)
    const response = await doIndexQuery(this.database.indexBlocks, this.indexByKey, query)
    // console.timeEnd(callId + '.doIndexQuery')
    return {
      proof: { index: await cidsToProof(response.cids) },
      rows: response.result.map(({ id, key, row }) => {
        return ({ id, key: charwise.decode(key), value: row })
      })
    }
  }

  /**
   * Update the DbIndex with the latest changes
   * @private
   * @returns {Promise<void>}
   */

  async updateIndex (blocks) {
    // todo this could enqueue the request and give fresh ones to all second comers -- right now it gives out stale promises while working
    // what would it do in a world where all indexes provide a database snapshot to query?
    if (this.updateIndexPromise) return this.updateIndexPromise
    this.updateIndexPromise = this.innerUpdateIndex(blocks)
    this.updateIndexPromise.finally(() => { this.updateIndexPromise = null })
    return this.updateIndexPromise
  }

  async innerUpdateIndex (inBlocks) {
    // const callTag = Math.random().toString(36).substring(4)
    // console.log(`updateIndex ${callTag} >`, this.instanceId, this.dbHead?.toString(), this.indexByKey.cid?.toString(), this.indexById.cid?.toString())
    // todo remove this hack
    if (ALWAYS_REBUILD) {
      this.indexById = { root: null, cid: null }
      this.indexByKey = { root: null, cid: null }
      this.dbHead = null
    }
    // console.log('dbHead', this.dbHead)
    // console.time(callTag + '.changesSince')
    const result = await this.database.changesSince(this.dbHead) // {key, value, del}
    // console.timeEnd(callTag + '.changesSince')
    // console.log('result.rows.length', result.rows.length)

    // console.time(callTag + '.doTransactionupdateIndex')
    // console.log('updateIndex changes length', result.rows.length)

    if (result.rows.length === 0) {
      // console.log('updateIndex < no changes', result.clock)
      this.dbHead = result.clock
      return
    }
    await doTransaction('updateIndex', inBlocks, async (blocks) => {
      let oldIndexEntries = []
      let removeByIdIndexEntries = []
      await loadIndex(blocks, this.indexById, idIndexOpts)
      await loadIndex(blocks, this.indexByKey, dbIndexOpts)
      if (this.dbHead) {
        const oldChangeEntries = await this.indexById.root.getMany(result.rows.map(({ key }) => key))
        oldIndexEntries = oldChangeEntries.result.map((key) => ({ key, del: true }))
        removeByIdIndexEntries = oldIndexEntries.map(({ key }) => ({ key: key[1], del: true }))
      }
      if (!this.mapFn) {
        throw new Error('No live map function installed for index, cannot update. Make sure your index definition runs before any queries.' + (this.mapFnString ? ' Your code should match the stored map function source:\n' + this.mapFnString : ''))
      }
      const indexEntries = indexEntriesForChanges(result.rows, this.mapFn)
      const byIdIndexEntries = indexEntries.map(({ key }) => ({ key: key[1], value: key }))
      this.indexById = await bulkIndex(blocks, this.indexById, removeByIdIndexEntries.concat(byIdIndexEntries), idIndexOpts)
      this.indexByKey = await bulkIndex(blocks, this.indexByKey, oldIndexEntries.concat(indexEntries), dbIndexOpts)
      this.dbHead = result.clock
    })
    this.database.notifyExternal('dbIndex')
    // console.timeEnd(callTag + '.doTransactionupdateIndex')
    // console.log(`updateIndex ${callTag} <`, this.instanceId, this.dbHead?.toString(), this.indexByKey.cid?.toString(), this.indexById.cid?.toString())
  }
}

/**
 * Update the DbIndex with the given entries
 * @param {Blockstore} blocks
 * @param {Block} inRoot
 * @param {DbIndexEntry[]} indexEntries
 * @private
 */
async function bulkIndex (blocks, inIndex, indexEntries, opts) {
  if (!indexEntries.length) return inIndex
  const putBlock = blocks.put.bind(blocks)
  const { getBlock } = makeGetBlock(blocks)
  let returnRootBlock
  let returnNode
  if (!inIndex.root) {
    const cid = inIndex.cid
    if (!cid) {
      for await (const node of await create({ get: getBlock, list: indexEntries, ...opts })) {
        const block = await node.block
        await putBlock(block.cid, block.bytes)
        returnRootBlock = block
        returnNode = node
      }
      return { root: returnNode, cid: returnRootBlock.cid }
    }
    inIndex.root = await load({ cid, get: getBlock, ...dbIndexOpts })
  }
  const { root, blocks: newBlocks } = await inIndex.root.bulk(indexEntries)
  returnRootBlock = await root.block
  returnNode = root
  for await (const block of newBlocks) {
    await putBlock(block.cid, block.bytes)
  }
  await putBlock(returnRootBlock.cid, returnRootBlock.bytes)
  return { root: returnNode, cid: returnRootBlock.cid }
}

async function loadIndex (blocks, index, indexOpts) {
  if (!index.root) {
    const cid = index.cid
    if (!cid) return
    const { getBlock } = makeGetBlock(blocks)
    index.root = await load({ cid, get: getBlock, ...indexOpts })
  }
  return index.root
}

async function applyLimit (results, limit) {
  results.result = results.result.slice(0, limit)
  return results
}

async function doIndexQuery (blocks, indexByKey, query = {}) {
  await loadIndex(blocks, indexByKey, dbIndexOpts)
  if (!indexByKey.root) return { result: [] }
  if (query.range) {
    const encodedRange = query.range.map((key) => charwise.encode(key))
    return applyLimit(await indexByKey.root.range(...encodedRange), query.limit)
  } else if (query.key) {
    const encodedKey = charwise.encode(query.key)
    return indexByKey.root.get(encodedKey)
  } else {
    const { result, ...all } = await indexByKey.root.getAllEntries()
    return applyLimit({ result: result.map(({ key: [k, id], value }) => ({ key: k, id, row: value })), ...all }, query.limit)
  }
}
