import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { mihomoProfileWorkDir, mihomoWorkDir } from './dirs'
import { parse } from './yaml'

interface IProxyGroupLike {
  name?: string
  type?: string
  proxies?: string[]
}

interface IChainedProxyContext {
  groups: IProxyGroupLike[]
  chainedProxies: IChainedProxyItem[]
  availableProxies: Map<string, Record<string, unknown>>
}

interface IChainedProxyValidationResult {
  valid: boolean
  reason?: string
}

interface IResolvedChainedProxyItem extends IChainedProxyItem {
  status: 'valid' | 'invalid'
  reason?: string
}

interface IProviderFilePayload {
  'proxy-providers'?: Record<string, { payload?: Record<string, unknown>[] }>
}

const DISALLOWED_PROXY_TYPES = new Set<MihomoProxyType>([
  'Direct',
  'Reject',
  'RejectDrop',
  'Pass',
  'Dns',
  'Compatible'
])

const ALLOWED_GROUP_TYPES = new Set(['selector', 'urltest', 'fallback', 'loadbalance'])

function normalizeGroupType(type: unknown): string {
  if (typeof type !== 'string') return ''
  return type.toLowerCase().replace(/[-_\s]/g, '')
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChainedProxyName(name: string, chainedProxies: IChainedProxyItem[], currentId: string): boolean {
  return chainedProxies.some((item) => item.id !== currentId && item.name === name)
}

function normalizeProxyArray(proxies: unknown): Record<string, unknown>[] {
  if (!Array.isArray(proxies)) return []
  return proxies.filter(isRecord)
}

function getProviderHash(url: string): string {
  return createHash('md5').update(url).digest('hex')
}

function resolveProviderPath(
  providerConfig: Record<string, unknown>,
  currentProfileId: string | undefined,
  diffWorkDir: boolean
): string {
  const directPath = typeof providerConfig.path === 'string' ? providerConfig.path : undefined
  if (directPath) {
    return directPath
  }
  const url = typeof providerConfig.url === 'string' ? providerConfig.url : ''
  return join(
    diffWorkDir ? mihomoProfileWorkDir(currentProfileId) : mihomoWorkDir(),
    `proxies/${getProviderHash(url)}`
  )
}

async function readProviderPayload(
  providerName: string,
  providerConfig: Record<string, unknown>,
  currentProfileId: string | undefined,
  diffWorkDir: boolean
): Promise<Record<string, unknown>[]> {
  const providerPath = resolveProviderPath(providerConfig, currentProfileId, diffWorkDir)
  if (!existsSync(providerPath)) {
    return []
  }

  const fileContent = await readFile(providerPath, 'utf-8')
  const parsed = parse(fileContent) as IProviderFilePayload | Record<string, unknown> | null
  if (!isRecord(parsed)) {
    return []
  }

  const namedPayload = parsed['proxy-providers']
  if (isRecord(namedPayload)) {
    const payload = namedPayload[providerName]
    if (isRecord(payload) && Array.isArray(payload.payload)) {
      return normalizeProxyArray(payload.payload)
    }
  }

  if (Array.isArray((parsed as { proxies?: unknown }).proxies)) {
    return normalizeProxyArray((parsed as { proxies?: unknown }).proxies)
  }

  return []
}

export async function collectBaseProxies(
  profile: IMihomoConfig,
  currentProfileId: string | undefined,
  diffWorkDir: boolean
): Promise<Map<string, Record<string, unknown>>> {
  const proxies = new Map<string, Record<string, unknown>>()

  for (const proxy of normalizeProxyArray(profile.proxies)) {
    const name = typeof proxy.name === 'string' ? proxy.name : ''
    if (!name) continue
    proxies.set(name, cloneRecord(proxy))
  }

  const providerConfigs = isRecord(profile['proxy-providers'])
    ? (profile['proxy-providers'] as Record<string, Record<string, unknown>>)
    : {}

  for (const [providerName, providerConfig] of Object.entries(providerConfigs)) {
    const payload = await readProviderPayload(
      providerName,
      providerConfig,
      currentProfileId,
      diffWorkDir
    )
    for (const proxy of payload) {
      const name = typeof proxy.name === 'string' ? proxy.name : ''
      if (!name || proxies.has(name)) continue
      proxies.set(name, cloneRecord(proxy))
    }
  }

  return proxies
}

export function buildChainedProxy(
  landingProxy: Record<string, unknown>,
  dialerProxyName: string,
  generatedName: string
): Record<string, unknown> {
  const chainedProxy = cloneRecord(landingProxy)
  chainedProxy.name = generatedName
  chainedProxy['dialer-proxy'] = dialerProxyName
  delete chainedProxy['provider-name']
  return chainedProxy
}

export function validateChainedProxyItem(
  item: IChainedProxyItem,
  context: IChainedProxyContext
): IChainedProxyValidationResult {
  const name = item.name.trim()
  if (!name) return { valid: false, reason: 'name-empty' }
  if (!item.group) return { valid: false, reason: 'group-missing' }
  if (!item.dialerProxy) return { valid: false, reason: 'dialer-missing' }
  if (!item.landingProxy) return { valid: false, reason: 'landing-missing' }
  if (item.dialerProxy === item.landingProxy) return { valid: false, reason: 'same-proxy' }
  if (isChainedProxyName(item.dialerProxy, context.chainedProxies, item.id)) {
    return { valid: false, reason: 'dialer-chained' }
  }
  if (isChainedProxyName(item.landingProxy, context.chainedProxies, item.id)) {
    return { valid: false, reason: 'landing-chained' }
  }

  const group = context.groups.find((value) => value.name === item.group)
  if (!group) return { valid: false, reason: 'group-missing' }
  if (!ALLOWED_GROUP_TYPES.has(normalizeGroupType(group.type))) {
    return { valid: false, reason: 'group-type-unsupported' }
  }

  const dialerProxy = context.availableProxies.get(item.dialerProxy)
  if (!dialerProxy) return { valid: false, reason: 'dialer-missing' }
  const landingProxy = context.availableProxies.get(item.landingProxy)
  if (!landingProxy) return { valid: false, reason: 'landing-missing' }

  const dialerType = dialerProxy.type as MihomoProxyType | undefined
  const landingType = landingProxy.type as MihomoProxyType | undefined
  if (dialerType && DISALLOWED_PROXY_TYPES.has(dialerType)) {
    return { valid: false, reason: 'dialer-type-unsupported' }
  }
  if (landingType && DISALLOWED_PROXY_TYPES.has(landingType)) {
    return { valid: false, reason: 'landing-type-unsupported' }
  }

  const duplicateProxy = Array.from(context.availableProxies.keys()).find(
    (proxyName) => proxyName === name && proxyName !== item.landingProxy
  )
  if (duplicateProxy) {
    return { valid: false, reason: 'name-conflict' }
  }
  if (context.groups.some((value) => value.name === name && value.name !== item.group)) {
    return { valid: false, reason: 'name-conflict' }
  }
  if (isChainedProxyName(name, context.chainedProxies, item.id)) {
    return { valid: false, reason: 'name-conflict' }
  }

  return { valid: true }
}

export function applyChainedProxies(
  profile: IMihomoConfig,
  chainedProxies: IChainedProxyItem[],
  availableProxies: Map<string, Record<string, unknown>>
): { profile: IMihomoConfig; resolvedItems: IResolvedChainedProxyItem[] } {
  const nextProfile = cloneRecord(profile)
  const groups = Array.isArray(nextProfile['proxy-groups'])
    ? (nextProfile['proxy-groups'] as IProxyGroupLike[])
    : []
  const nextProxies = normalizeProxyArray(nextProfile.proxies)

  const context: IChainedProxyContext = {
    groups,
    chainedProxies,
    availableProxies
  }

  const resolvedItems: IResolvedChainedProxyItem[] = []

  for (const item of chainedProxies) {
    if (item.enabled === false) {
      resolvedItems.push({ ...item, status: 'invalid', reason: 'disabled' })
      continue
    }

    const validation = validateChainedProxyItem(item, context)
    if (!validation.valid) {
      resolvedItems.push({ ...item, status: 'invalid', reason: validation.reason })
      continue
    }

    const landingProxy = availableProxies.get(item.landingProxy)
    if (!landingProxy) {
      resolvedItems.push({ ...item, status: 'invalid', reason: 'landing-missing' })
      continue
    }

    const chainedProxy = buildChainedProxy(landingProxy, item.dialerProxy, item.name)
    nextProxies.push(chainedProxy)
    availableProxies.set(item.name, cloneRecord(chainedProxy))

    const group = groups.find((value) => value.name === item.group)
    if (!group) {
      resolvedItems.push({ ...item, status: 'invalid', reason: 'group-missing' })
      continue
    }

    const groupProxies = Array.isArray(group.proxies) ? group.proxies : []
    if (!groupProxies.includes(item.name)) {
      group.proxies = [...groupProxies, item.name]
    }

    resolvedItems.push({ ...item, status: 'valid' })
  }

  nextProfile.proxies = nextProxies as IMihomoConfig['proxies']
  nextProfile['proxy-groups'] = groups as IMihomoConfig['proxy-groups']

  return {
    profile: nextProfile,
    resolvedItems
  }
}

export function buildChainedProxyStatus(
  item: IResolvedChainedProxyItem
): IChainedProxyStatus {
  return {
    id: item.id,
    group: item.group,
    dialerProxy: item.dialerProxy,
    landingProxy: item.landingProxy,
    status: item.status,
    reason: item.reason,
    derived: true
  }
}

export function mapChainedReason(reason: string | undefined): string {
  switch (reason) {
    case 'name-empty':
      return 'Name is required'
    case 'group-missing':
      return 'Target group not found'
    case 'dialer-missing':
      return 'Entry proxy not found'
    case 'landing-missing':
      return 'Exit proxy not found'
    case 'same-proxy':
      return 'Entry and exit proxies cannot be the same'
    case 'dialer-chained':
      return 'Entry proxy cannot be a chained proxy'
    case 'landing-chained':
      return 'Exit proxy cannot be a chained proxy'
    case 'group-type-unsupported':
      return 'Current group does not support chained proxies'
    case 'dialer-type-unsupported':
      return 'Entry proxy type is not supported'
    case 'landing-type-unsupported':
      return 'Exit proxy type is not supported'
    case 'name-conflict':
      return 'Name conflicts with an existing proxy or group'
    case 'disabled':
      return 'Chained proxy is disabled'
    default:
      return 'Chained proxy is invalid'
  }
}
