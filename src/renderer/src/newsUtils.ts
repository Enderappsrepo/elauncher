import type { NewsItem } from '@shared/types'

export function newsTagClass(item: NewsItem): string {
  if (item.category === 'launcher') return ' launcher'
  if (item.category === 'patch-notes') return ' patch'
  return ''
}
