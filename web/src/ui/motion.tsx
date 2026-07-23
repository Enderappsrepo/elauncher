import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

/* Motion primitives for both Pages apps.
 *
 * The timing vocabulary is the one the CSS layer already speaks (tokens.css):
 * --ease-out for state changes, --ease-spring for entrances, nothing longer
 * than 420ms. These are the same curves as JS arrays, so a component animated
 * by Motion and one animated by CSS read as the same system.
 *
 * Everything routes through <MotionRoot>, whose reducedMotion="user" turns
 * transform/opacity choreography off for people who asked their OS for less —
 * matching the @media rule that already guards the CSS animations.
 */

export const EASE_OUT = [0.22, 1, 0.36, 1] as const
export const EASE_SPRING = [0.2, 0.9, 0.3, 1.15] as const

export { AnimatePresence, motion, useReducedMotion }

export function MotionRoot({ children }: { children: ReactNode }): React.JSX.Element {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

/** Mount entrance: the JS twin of the CSS `.rise` utility. */
export function Rise({
  children,
  delay = 0,
  className
}: {
  children: ReactNode
  delay?: number
  className?: string
}): React.JSX.Element {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.42, delay, ease: EASE_SPRING }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Scroll entrance for landing sections: reveals once, a little before the
 * element is fully on screen so the motion is caught mid-scroll rather than
 * played to nobody.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as = 'div'
}: {
  children: ReactNode
  delay?: number
  className?: string
  as?: 'div' | 'section' | 'article'
}): React.JSX.Element {
  const Tag = as === 'article' ? motion.article : as === 'section' ? motion.section : motion.div
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -80px 0px' }}
      transition={{ duration: 0.55, delay, ease: EASE_OUT }}
    >
      {children}
    </Tag>
  )
}

/* Parent/child variants for staggered lists. Used as:
 *   <motion.div variants={staggerParent} initial="hidden" whileInView="show" …>
 *     <motion.div variants={staggerChild} />
 * The cap mirrors the CSS `.stagger` rule: choreography never makes a long
 * list slower to read than a short one.
 */
export const staggerParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } }
}

export const staggerChild = {
  hidden: { opacity: 0, y: 14, scale: 0.985 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE_SPRING } }
}

/**
 * Animated open/close for accordions and disclosure rows.
 *
 * Height is measured by Motion ('auto' keyframes), so the content can be any
 * size; overflow stays hidden only while moving, or focus outlines inside get
 * clipped at rest.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: EASE_OUT }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Cross-fade between screens keyed by `id` — sections of the panel, tabs of a
 * server. Fade + a small rise; never a slide, which would imply spatial order
 * the sections don't have.
 */
export function Switch({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
