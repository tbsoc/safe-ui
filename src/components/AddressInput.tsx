import { useId, useMemo, useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { shortAddress } from '../lib/format'
import { useNames } from '../names'

/**
 * Address field with address-book lookup: type a name (or the start of an address) and pick from the
 * matches, which fills in the address. Once a known address is entered, its name is shown below.
 */
export function AddressInput(props: {
  value: string
  onChange: (value: string) => void
  id?: string
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
}) {
  const { names } = useNames()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const q = props.value.trim().toLowerCase()

  const matches = useMemo(() => {
    if (!q || isAddress(props.value.trim())) return []
    return Object.entries(names)
      .filter(([addr, e]) => e.name.toLowerCase().includes(q) || addr.startsWith(q))
      .sort(([, a], [, b]) => {
        // Names that start with the query first, then alphabetical.
        const as = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return as - bs || a.name.localeCompare(b.name)
      })
      .slice(0, 8)
      .map(([addr, e]) => ({ address: getAddress(addr), name: e.name }))
  }, [names, q, props.value])

  const known = isAddress(props.value.trim()) ? names[props.value.trim().toLowerCase()]?.name : undefined
  const showList = open && matches.length > 0 && !props.disabled
  const lookingUpName = !!q && !q.startsWith('0x')

  const pick = (address: string) => {
    props.onChange(address)
    setOpen(false)
  }

  return (
    <div className="addr-input">
      <input
        id={props.id}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!showList) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a - 1 + matches.length) % matches.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(matches[active].address)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        placeholder={props.placeholder ?? 'Name or 0x…'}
        aria-label={props.ariaLabel}
        spellCheck={false}
        autoComplete="off"
        disabled={props.disabled}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {showList && (
        <ul className="suggest" id={listId} role="listbox">
          {matches.map((m, i) => (
            <li
              key={m.address}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(m.address)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <strong>{m.name}</strong>
              <code>{shortAddress(m.address)}</code>
            </li>
          ))}
        </ul>
      )}
      {known && <small className="addr-known">✓ {known}</small>}
      {lookingUpName && matches.length === 0 && open && <small className="hint">No name in the address book matches “{props.value.trim()}”.</small>}
    </div>
  )
}
