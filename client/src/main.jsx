import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: 'var(--bg4)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            fontFamily: 'var(--mono)',
            fontSize: '12px',
          },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
)
