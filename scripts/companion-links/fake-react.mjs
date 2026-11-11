// Just enough of React to run a hook outside a renderer: state slots, effects run once on mount.
const slots = []
let next = 0
let effects = []
export function useState(init) {
  const k = next++
  if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init
  return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v }]
}
export function useEffect(fn) { effects.push(fn) }
export function mount(hook) {
  slots.length = 0
  next = 0
  effects = []
  const first = hook()
  const cleanups = effects.map((f) => f())
  return {
    first,
    current: () => { next = 0; effects = []; return hook() },
    unmount: () => cleanups.forEach((c) => typeof c === 'function' && c())
  }
}
export default { useState, useEffect }
