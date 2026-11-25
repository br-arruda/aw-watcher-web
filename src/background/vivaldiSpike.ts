import type { AWClient, IEvent } from 'aw-client'
import { getHostname } from '../storage'

// Spike temporário (attention-tracker, Estágio 4 S1b): registra o que o Vivaldi expõe à extensão
// sobre a aba ativa, para descobrir como identificar o workspace dela. Sai antes do merge.

const BUCKET_TYPE = 'vivaldi.spike'
const HIDDEN_KEYS = new Set(['url', 'title', 'favIconUrl', 'pendingUrl'])
const THUMBNAIL_KEYS = new Set(['thumbnail', 'urlForThumbnail'])

type ChromeLike = Record<string, any>
const chromeApi = () => (globalThis as { chrome?: ChromeLike }).chrome

function parseVivExtData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(([k]) => !THUMBNAIL_KEYS.has(k)),
    )
  } catch {
    return { unparsed: raw.slice(0, 200) }
  }
}

function withoutContent(tab: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(tab)
      .filter(([k]) => !HIDDEN_KEYS.has(k))
      .map(([k, v]) => [k, k === 'vivExtData' ? parseVivExtData(v) : v]),
  )
}

async function snapshot(reason: string) {
  const c = chromeApi()
  if (!c?.tabs) return null
  const [active] = await c.tabs.query({ active: true, lastFocusedWindow: true })
  if (!active?.id) return null
  const tab = await c.tabs.get(active.id)
  const group =
    tab.groupId >= 0 && c.tabGroups
      ? await c.tabGroups.get(tab.groupId).catch(() => null)
      : null
  const window = await c.windows.get(tab.windowId).catch(() => null)
  const siblings: Record<string, unknown>[] = await c.tabs.query({
    windowId: tab.windowId,
  })
  return {
    reason,
    host: (() => {
      try {
        return new URL(tab.url).host
      } catch {
        return ''
      }
    })(),
    tab: withoutContent(tab),
    group,
    window: window ? withoutContent(window) : null,
    windowTabs: siblings.map((t) => ({
      index: t.index,
      active: t.active,
      groupId: t.groupId,
      hidden: t.hidden,
      vivExtData: parseVivExtData(t.vivExtData),
    })),
    namespaces: Object.keys(c).sort(),
  }
}

export function startVivaldiSpike(client: AWClient) {
  const c = chromeApi()
  if (!c?.tabs) return
  let bucketId: string | undefined
  const record = async (reason: string) => {
    try {
      const data = await snapshot(reason)
      if (!data) return
      if (!bucketId) {
        const hostname = (await getHostname()) ?? 'unknown'
        bucketId = `vivaldi-spike_${hostname}`
        await client.ensureBucket(bucketId, BUCKET_TYPE, hostname)
      }
      await client.insertEvents(bucketId, [
        {
          timestamp: new Date(),
          duration: 0,
          data: data as unknown as IEvent['data'],
        },
      ])
    } catch (err) {
      console.warn('vivaldi spike failed', err)
    }
  }
  c.tabs.onActivated.addListener(() => record('tabs.onActivated'))
  c.tabs.onUpdated.addListener(
    (
      _id: number,
      change: Record<string, unknown>,
      tab: { active?: boolean },
    ) => {
      if (tab.active && (change.status === 'complete' || 'groupId' in change))
        record('tabs.onUpdated')
    },
  )
  c.windows?.onFocusChanged.addListener(() => record('windows.onFocusChanged'))
  void record('start')
}
