import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@web/styles/base.css'
import '@web/styles/ui.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
