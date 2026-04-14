import { useState, useEffect, useCallback, useRef } from 'react'

const MIN = 48
const LS_PREFIX = 'np-cols:'

/**
 * Persisted column widths (localStorage). Drag the right edge of a header cell to resize;
 * width is taken from the neighbor column when not the last column.
 */
export function useResizableColumns(storageKey, defaultWidths) {
  const key = `${LS_PREFIX}${storageKey}`
  const defRef = useRef(defaultWidths)
  defRef.current = defaultWidths
  const len = defaultWidths.length

  const [widths, setWidths] = useState(() => [...defaultWidths])

  useEffect(() => {
    const d = defRef.current
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const p = JSON.parse(raw)
        if (Array.isArray(p) && p.length === d.length) {
          setWidths(p.map((n, i) => (typeof n === 'number' && n >= MIN ? n : d[i])))
          return
        }
      }
    } catch {
      /* ignore */
    }
    setWidths([...d])
  }, [storageKey, key, len])

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(widths))
    } catch {
      /* ignore */
    }
  }, [key, widths])

  const startResize = useCallback(
    (colIndex, e) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const start = [...widths]
      const onMove = (ev) => {
        const dx = ev.clientX - startX
        if (colIndex < start.length - 1) {
          const total = start[colIndex] + start[colIndex + 1]
          let nextA = start[colIndex] + dx
          nextA = Math.max(MIN, Math.min(nextA, total - MIN))
          setWidths((w) => {
            const n = [...w]
            n[colIndex] = nextA
            n[colIndex + 1] = total - nextA
            return n
          })
        } else {
          setWidths((w) => {
            const n = [...w]
            n[colIndex] = Math.max(MIN, start[colIndex] + dx)
            return n
          })
        }
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [widths],
  )

  const sumWidth = widths.reduce((a, b) => a + b, 0)

  return { widths, startResize, sumWidth }
}

export function ResizableColGroup({ widths }) {
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  )
}

export function ResizableTh({ children, columnIndex, columnCount, startResize, style, ...rest }) {
  const last = columnIndex === columnCount - 1
  return (
    <th
      {...rest}
      style={{
        ...style,
        position: 'relative',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
      {!last && (
        <span
          role="separator"
          aria-hidden
          onMouseDown={(e) => startResize(columnIndex, e)}
          title="Drag to resize column"
          className="np-col-resize-handle"
        />
      )}
    </th>
  )
}

/** Generic table: pass columns [{ label, thStyle? }], tbody as children. */
export function ResizableColsTable({ tableId, defaultWidths, columns, tableStyle = {}, thBaseStyle = {}, children }) {
  const n = columns.length
  const { widths, startResize, sumWidth } = useResizableColumns(tableId, defaultWidths)
  return (
    <table
      style={{
        width: '100%',
        tableLayout: 'fixed',
        minWidth: sumWidth,
        borderCollapse: 'collapse',
        ...tableStyle,
      }}
    >
      <ResizableColGroup widths={widths} />
      <thead>
        <tr>
          {columns.map((col, i) => (
            <ResizableTh
              key={i}
              columnIndex={i}
              columnCount={n}
              startResize={startResize}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                fontSize: 10,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.6,
                color: 'var(--text3)',
                borderBottom: '1px solid var(--border)',
                fontFamily: 'var(--mono)',
                ...thBaseStyle,
                ...col.thStyle,
              }}
            >
              {col.label}
            </ResizableTh>
          ))}
        </tr>
      </thead>
      {children}
    </table>
  )
}
