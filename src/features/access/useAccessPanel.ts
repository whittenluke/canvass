import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { accessDisplayName, splitFullName } from '../app/utils'
import type { AccessRow } from '../app/types'

type UseAccessPanelArgs = {
  role: string
  session: Session | null
}

type AdminAccessPanelRpcRow = {
  email: string
  role: string
  first_name: string | null
  last_name: string | null
  profile_exists: boolean
}

export function useAccessPanel({ role, session }: UseAccessPanelArgs) {
  const [accessRows, setAccessRows] = useState<AccessRow[]>([])
  const [isProfilesLoading, setIsProfilesLoading] = useState(false)
  const [isAddingUser, setIsAddingUser] = useState(false)
  const [addUserModalOpen, setAddUserModalOpen] = useState(false)
  const [openAccessActionsEmail, setOpenAccessActionsEmail] = useState('')
  const [accessMessage, setAccessMessage] = useState('')
  const [newProfileName, setNewProfileName] = useState('')
  const [newProfileEmail, setNewProfileEmail] = useState('')
  const [newProfileRole, setNewProfileRole] = useState<'admin' | 'canvasser'>('canvasser')
  const [editingUserEmail, setEditingUserEmail] = useState('')
  const [editingUserNameDraft, setEditingUserNameDraft] = useState('')
  const [editingUserEmailDraft, setEditingUserEmailDraft] = useState('')
  const [editingUserRoleDraft, setEditingUserRoleDraft] = useState<'admin' | 'canvasser'>('canvasser')

  const buildAccessRows = (
    accessData: {
      email: string
      role: 'admin' | 'canvasser'
      first_name: string | null
      last_name: string | null
    }[] | null,
    profileData: { email: string; role?: 'admin' | 'canvasser' }[] | null,
  ): AccessRow[] => {
    const byEmail = new Map<string, AccessRow>()
    const profiles = profileData ?? []
    const activeEmails = new Set(profiles.map((row) => row.email.toLowerCase()))

    ;(accessData ?? []).forEach((row) => {
      byEmail.set(row.email.toLowerCase(), {
        email: row.email,
        role: row.role,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        status: (activeEmails.has(row.email.toLowerCase()) ? 'active' : 'pending') as 'active' | 'pending',
      })
    })

    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email))
  }

  const accessRowsFromAdminPanelRpc = (raw: unknown): AccessRow[] | null => {
    let list: unknown = raw
    if (typeof raw === 'string') {
      try {
        list = JSON.parse(raw) as unknown
      } catch {
        return null
      }
    }
    if (!Array.isArray(list)) return null
    const rows: AccessRow[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const r = item as AdminAccessPanelRpcRow
      const nextRole = r.role === 'admin' ? 'admin' : 'canvasser'
      rows.push({
        email: r.email,
        role: nextRole,
        first_name: r.first_name ?? null,
        last_name: r.last_name ?? null,
        status: r.profile_exists ? 'active' : 'pending',
      })
    }
    return rows.sort((a, b) => a.email.localeCompare(b.email))
  }

  const refreshAccessList = useCallback(async () => {
    if (!supabase || role !== 'admin') {
      return
    }

    setIsProfilesLoading(true)
    setAccessMessage('')

    const { data: panelData, error: panelError } = await supabase.rpc('admin_list_access_panel')

    if (!panelError && panelData !== null && panelData !== undefined) {
      const fromRpc = accessRowsFromAdminPanelRpc(panelData)
      if (fromRpc) {
        setAccessRows(fromRpc)
        setIsProfilesLoading(false)
        return
      }
    }

    const rpcMissing =
      panelError && /could not find|does not exist|schema cache/i.test(panelError.message ?? '')

    if (panelError && !rpcMissing) {
      setAccessMessage(panelError.message ?? 'Failed to load access.')
      setIsProfilesLoading(false)
      return
    }

    const { data: accessData, error: accessError } = await supabase
      .from('user_access')
      .select('email,role,first_name,last_name')
      .in('role', ['admin', 'canvasser'])
      .order('email', { ascending: true })

    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('email,role')
      .in('role', ['admin', 'canvasser'])

    if (accessError || profileError) {
      setAccessMessage(accessError?.message ?? profileError?.message ?? 'Failed to load access.')
    } else {
      const rows = buildAccessRows(
        (accessData as {
          email: string
          role: 'admin' | 'canvasser'
          first_name: string | null
          last_name: string | null
        }[] | null) ?? [],
        (profileData as { email: string; role?: 'admin' | 'canvasser' }[] | null) ?? [],
      )
      setAccessRows(rows)
    }
    setIsProfilesLoading(false)
  }, [role])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- refreshing access rows by role/session */
    void refreshAccessList()
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [refreshAccessList, role, session])

  const upsertProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase || role !== 'admin') {
      return
    }

    const email = newProfileEmail.trim().toLowerCase()
    const { firstName, lastName } = splitFullName(newProfileName)
    if (!firstName) {
      setAccessMessage('Name is required.')
      return
    }
    if (!email) {
      setAccessMessage('Email is required.')
      return
    }

    setIsAddingUser(true)
    const { error } = await supabase.rpc('admin_set_user_access', {
      target_email: email,
      target_role: newProfileRole,
      target_first_name: firstName,
      target_last_name: lastName,
    })
    setIsAddingUser(false)

    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage(
      'Access saved. They can open the app, enter this email, and choose a password (first time) or sign in.',
    )
    setNewProfileName('')
    setNewProfileEmail('')
    setNewProfileRole('canvasser')
    setAddUserModalOpen(false)

    await refreshAccessList()
  }

  const startEditUser = (entry: AccessRow) => {
    setEditingUserEmail(entry.email)
    setEditingUserNameDraft(accessDisplayName(entry))
    setEditingUserEmailDraft(entry.email)
    setEditingUserRoleDraft(entry.role)
    setOpenAccessActionsEmail('')
    setAccessMessage('')
  }

  const cancelEditUser = () => {
    setEditingUserEmail('')
    setEditingUserNameDraft('')
    setEditingUserEmailDraft('')
    setEditingUserRoleDraft('canvasser')
  }

  const saveEditedUser = async (currentEmail: string) => {
    if (!supabase || role !== 'admin') {
      return
    }

    const nextEmail = editingUserEmailDraft.trim().toLowerCase()
    const { firstName, lastName } = splitFullName(editingUserNameDraft)
    if (!firstName) {
      setAccessMessage('Name is required.')
      return
    }
    if (!nextEmail) {
      setAccessMessage('Email is required.')
      return
    }

    if (nextEmail !== currentEmail.toLowerCase()) {
      const { error } = await supabase.rpc('admin_update_user_email', {
        old_email: currentEmail.toLowerCase(),
        new_email: nextEmail,
      })
      if (error) {
        setAccessMessage(error.message)
        return
      }
    }

    const { error } = await supabase.rpc('admin_set_user_access', {
      target_email: nextEmail,
      target_role: editingUserRoleDraft,
      target_first_name: firstName,
      target_last_name: lastName,
    })
    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('User updated.')
    cancelEditUser()
    await refreshAccessList()
  }

  const deleteUserAccess = async (targetEmail: string) => {
    if (!supabase || role !== 'admin') {
      return
    }

    const confirmed = window.confirm(`Delete ${targetEmail} from app access?`)
    if (!confirmed) {
      return
    }

    const { error } = await supabase.rpc('admin_delete_user_access', {
      target_email: targetEmail.toLowerCase(),
    })

    if (error) {
      setAccessMessage(error.message)
      return
    }

    setAccessMessage('User access removed.')
    setAccessRows((current) =>
      current.filter((entry) => entry.email.toLowerCase() !== targetEmail.toLowerCase()),
    )
    if (editingUserEmail.toLowerCase() === targetEmail.toLowerCase()) {
      cancelEditUser()
    }
    await refreshAccessList()
  }

  return {
    accessRows,
    isProfilesLoading,
    isAddingUser,
    addUserModalOpen,
    setAddUserModalOpen,
    openAccessActionsEmail,
    setOpenAccessActionsEmail,
    accessMessage,
    setAccessMessage,
    newProfileName,
    setNewProfileName,
    newProfileEmail,
    setNewProfileEmail,
    newProfileRole,
    setNewProfileRole,
    editingUserEmail,
    editingUserNameDraft,
    setEditingUserNameDraft,
    editingUserEmailDraft,
    setEditingUserEmailDraft,
    editingUserRoleDraft,
    setEditingUserRoleDraft,
    refreshAccessList,
    upsertProfile,
    startEditUser,
    cancelEditUser,
    saveEditedUser,
    deleteUserAccess,
  }
}
