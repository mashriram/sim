'use client'

import type { WorkspaceUserPermissions } from '@/hooks/use-user-permissions'
import { Marketplace } from './marketplace'

interface ToolbarProps {
  userPermissions: WorkspaceUserPermissions
  isWorkspaceSelectorVisible?: boolean
}

export function Toolbar({ userPermissions, isWorkspaceSelectorVisible = false }: ToolbarProps) {
  // Switched to Marketplace UI
  return <Marketplace userPermissions={userPermissions} />
}
