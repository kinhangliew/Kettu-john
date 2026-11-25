import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { imageOrigin } from '@shared/artifact-image'
import type { Project } from '@shared/agent-host'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { errorMessage, host } from '@renderer/lib/host'
import { useImageSettings } from './project-image-settings-model'

export function ProjectImageSettings() {
  const project = useImageSettings((s) => s.project)
  return (
    <Dialog
      open={!!project}
      onOpenChange={(open) => {
        if (!open) useImageSettings.setState({ project: null })
      }}
    >
      {project && <Sources key={project.path} project={project} />}
    </Dialog>
  )
}

function Sources({ project }: { project: Project }) {
  const { t } = useTranslation('sidebar')
  const [origins, setOrigins] = useState<string[] | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const origin = imageOrigin(input.trim())
  const path = project.path
  useEffect(() => {
    let active = true
    host('projects.imageOrigins', { path }).then(
      (list) => {
        if (active) setOrigins(list)
      },
      (failure) => {
        if (active) setError(errorMessage(failure))
      },
    )
    return () => {
      active = false
    }
  }, [path, attempt])
  async function change(target: string, allowed: boolean) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await host('projects.setImageOrigin', { path, origin: target, allowed })
      const list = await host('projects.imageOrigins', { path })
      setOrigins(list)
      if (allowed) setInput('')
    } catch (failure) {
      setError(errorMessage(failure))
      setOrigins(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('imageSettings.title', { project: project.name })}</DialogTitle>
        <DialogDescription>{t('imageSettings.hint')}</DialogDescription>
      </DialogHeader>
      {origins === null ? (
        !error && <Skeleton className="h-9 w-full" />
      ) : (
        <>
          <div className="max-h-60 overflow-y-auto">
            {origins.length ? (
              origins.map((item) => (
                <div key={item} className="flex items-center justify-between gap-3">
                  <span className="break-all">{item}</span>
                  <Button variant="ghost" disabled={busy} onClick={() => void change(item, false)}>
                    {t('imageSettings.remove')}
                  </Button>
                </div>
              ))
            ) : (
              <p className="text-small text-muted-foreground">{t('imageSettings.none')}</p>
            )}
          </div>
          <label className="grid gap-2">
            {t('imageSettings.input')}
            <Input
              type="url"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://example.com"
            />
          </label>
          {input.trim() && !origin && (
            <p className="text-small text-danger">{t('imageSettings.invalid')}</p>
          )}
          {origin && (
            <Button
              disabled={busy || origins.includes(origin)}
              onClick={() => void change(origin, true)}
            >
              {t('imageSettings.allow', { origin })}
            </Button>
          )}
        </>
      )}
      {error && (
        <>
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setError('')
              setAttempt((n) => n + 1)
            }}
          >
            {t('imageSettings.retry')}
          </Button>
        </>
      )}
    </DialogContent>
  )
}
