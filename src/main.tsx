import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './lib/i18n'
import { AppProvider } from './lib/store'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </I18nProvider>
  </React.StrictMode>,
)