import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, type ReactNode } from 'react'
import { fetchNames, NamesUnavailableError, type NameEntry } from './lib/names'

interface NamesContextValue {
  names: Record<string, NameEntry>
  available: boolean | undefined
  refetch: () => unknown
}

const NamesContext = createContext<NamesContextValue>({ names: {}, available: undefined, refetch: () => {} })

/** Loads the shared address book once for the whole app. Missing backend = no names, no errors. */
export function NamesProvider({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: ['names'],
    queryFn: async () => {
      try {
        return { available: true, names: await fetchNames() }
      } catch (e) {
        if (e instanceof NamesUnavailableError) return { available: false, names: {} }
        throw e
      }
    },
    staleTime: 60_000,
  })
  return (
    <NamesContext.Provider value={{ names: q.data?.names ?? {}, available: q.data?.available, refetch: () => q.refetch() }}>
      {children}
    </NamesContext.Provider>
  )
}

export function useNames() {
  return useContext(NamesContext)
}

export function useAddressName(address?: string): string | undefined {
  const { names } = useNames()
  return address ? names[address.toLowerCase()]?.name : undefined
}
