/**
 * Client Redis minimal (protocole RESP sur TCP), sans dépendance.
 *
 * Quatre commandes suffisent à l'anti-rejeu : GET, SET, DEL et
 * `SET key value NX PX ttl` — cette dernière étant atomique côté serveur,
 * c'est elle qui porte la garantie.
 *
 * RESP : https://redis.io/docs/latest/develop/reference/protocol-spec/
 */
import { createConnection, type Socket } from 'node:net'

export class RedisError extends Error {
  override name = 'RedisError'
}

type Reply = string | null | number

/** Encode une commande en RESP (tableau de chaînes en vrac). */
function encode(args: readonly string[]): string {
  let out = `*${args.length}\r\n`
  for (const arg of args) out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`
  return out
}

export type RedisClient = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>
  close(): Promise<void>
}

export async function connectRedis(url: string): Promise<RedisClient> {
  const parsed = new URL(url)
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection(
      { host: parsed.hostname, port: Number(parsed.port || 6379) },
      () => resolve(s),
    )
    s.once('error', reject)
  })
  socket.setNoDelay(true)

  // Les commandes sont sérialisées : une réponse à la fois, dans l'ordre.
  let queue: Promise<unknown> = Promise.resolve()
  let buffer = ''

  const send = (args: readonly string[]): Promise<Reply> => {
    const run = (): Promise<Reply> =>
      new Promise((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const parsed = parseReply(buffer)
          if (parsed === undefined) return // réponse incomplète
          buffer = parsed.rest
          cleanup()
          if (parsed.error) reject(new RedisError(parsed.error))
          else resolve(parsed.value)
        }
        const onError = (error: Error) => {
          cleanup()
          reject(new RedisError(error.message))
        }
        const cleanup = () => {
          socket.off('data', onData)
          socket.off('error', onError)
        }
        socket.on('data', onData)
        socket.once('error', onError)
        socket.write(encode(args))
      })

    const result = queue.then(run, run)
    queue = result.catch(() => undefined)
    return result
  }

  return {
    async get(key) {
      return (await send(['GET', key])) as string | null
    },
    async set(key, value) {
      return await send(['SET', key, value])
    },
    async del(key) {
      return await send(['DEL', key])
    },
    async setNxPx(key, value, ttlMs) {
      // Renvoie OK si la clé a été posée, nil si elle existait déjà.
      return (await send(['SET', key, value, 'NX', 'PX', String(Math.ceil(ttlMs))])) !== null
    },
    async close() {
      await new Promise<void>((resolve) => socket.end(resolve))
    },
  }
}

/** Analyse une réponse RESP. `undefined` = il manque des octets. */
function parseReply(
  input: string,
): { value: Reply; error?: string; rest: string } | undefined {
  const end = input.indexOf('\r\n')
  if (end === -1) return undefined
  const head = input.slice(0, end)
  const rest = input.slice(end + 2)
  const type = head[0]
  const body = head.slice(1)

  switch (type) {
    case '+':
      return { value: body, rest }
    case '-':
      return { value: null, error: body, rest }
    case ':':
      return { value: Number(body), rest }
    case '$': {
      const length = Number(body)
      if (length === -1) return { value: null, rest }
      if (rest.length < length + 2) return undefined
      return { value: rest.slice(0, length), rest: rest.slice(length + 2) }
    }
    default:
      return { value: null, error: `réponse RESP inattendue : ${head}`, rest }
  }
}
