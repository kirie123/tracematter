import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppProvider } from './lib/store'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
)