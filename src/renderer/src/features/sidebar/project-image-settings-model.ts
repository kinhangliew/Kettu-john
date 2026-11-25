import { create } from 'zustand'
import type { Project } from '@shared/agent-host'

export const useImageSettings = create<{ project: Project | null }>(() => ({ project: null }))
