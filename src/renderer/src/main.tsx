import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AppStateProvider } from './state'
import { ToastProvider } from './toast'
import { applyTheme, getTheme } from './theme'
import '@fontsource-variable/inter/index.css'
import './styles.css'

// paint the saved theme before the first render to avoid a flash
applyTheme(getTheme())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <ToastProvider>
        <AppStateProvider>
          <App />
        </AppStateProvider>
      </ToastProvider>
    </HashRouter>
  </React.StrictMode>
)
