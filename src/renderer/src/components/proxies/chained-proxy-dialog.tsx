import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem
} from '@heroui/react'
import React, { useEffect, useMemo, useState } from 'react'
import { toast } from '@renderer/components/base/toast'
import { upsertCurrentProfileChainedProxy } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'

interface Props {
  groupName: string
  proxies: IMihomoProxy[]
  initialValue?: IChainedProxyItem
  onClose: () => void
}

function buildDefaultName(landingProxy: string, dialerProxy: string): string {
  if (!landingProxy || !dialerProxy) return ''
  return `${landingProxy} -> ${dialerProxy}`
}

const ChainedProxyDialog: React.FC<Props> = ({ groupName, proxies, initialValue, onClose }) => {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(initialValue?.name || '')
  const [dialerProxy, setDialerProxy] = useState(initialValue?.dialerProxy || '')
  const [landingProxy, setLandingProxy] = useState(initialValue?.landingProxy || '')

  const proxyOptions = useMemo(() => proxies.map((proxy) => proxy.name), [proxies])

  useEffect(() => {
    if (initialValue) return
    if (!name || name === buildDefaultName(landingProxy, dialerProxy)) {
      setName(buildDefaultName(landingProxy, dialerProxy))
    }
  }, [dialerProxy, landingProxy, initialValue, name])

  const onSave = async (): Promise<void> => {
    if (!dialerProxy || !landingProxy) {
      toast.error(t('proxies.chain.errors.proxyRequired'))
      return
    }
    if (dialerProxy === landingProxy) {
      toast.error(t('proxies.chain.errors.sameProxy'))
      return
    }
    if (!name.trim()) {
      toast.error(t('proxies.chain.errors.nameRequired'))
      return
    }

    setSaving(true)
    try {
      await upsertCurrentProfileChainedProxy({
        id: initialValue?.id || `${Date.now()}`,
        name: name.trim(),
        group: groupName,
        dialerProxy,
        landingProxy,
        enabled: true,
        lastKnownType: proxies.find((proxy) => proxy.name === landingProxy)?.type
      })
      toast.success(
        initialValue ? t('proxies.chain.updated') : t('proxies.chain.created')
      )
      onClose()
    } catch (error) {
      toast.error(String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      backdrop="blur"
      classNames={{ backdrop: 'top-[48px]' }}
      hideCloseButton
      isOpen={true}
      onOpenChange={onClose}
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader className="flex app-drag">
          {initialValue ? t('proxies.chain.edit') : t('proxies.chain.create')}
        </ModalHeader>
        <ModalBody>
          <Input
            size="sm"
            label={t('proxies.chain.group')}
            value={groupName}
            isReadOnly
          />
          <Select
            size="sm"
            label={t('proxies.chain.entryProxy')}
            selectedKeys={dialerProxy ? new Set([dialerProxy]) : new Set([])}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0]
              setDialerProxy(typeof value === 'string' ? value : '')
            }}
          >
            {proxyOptions.map((proxy) => (
              <SelectItem key={proxy}>{proxy}</SelectItem>
            ))}
          </Select>
          <Select
            size="sm"
            label={t('proxies.chain.exitProxy')}
            selectedKeys={landingProxy ? new Set([landingProxy]) : new Set([])}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0]
              setLandingProxy(typeof value === 'string' ? value : '')
            }}
          >
            {proxyOptions.map((proxy) => (
              <SelectItem key={proxy}>{proxy}</SelectItem>
            ))}
          </Select>
          <Input
            size="sm"
            label={t('proxies.chain.name')}
            value={name}
            onValueChange={setName}
          />
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="light" onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" color="primary" isLoading={saving} onPress={onSave}>
            {t('common.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default ChainedProxyDialog
