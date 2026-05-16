import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'
ReactDOM.createRoot(document.getElementById('root')).render(
  // StrictMode intentionally double-invokes effects in development to surface
  // side-effect bugs. This causes two simultaneous guacd/RDP sessions to open,
  // which Windows then terminates with ECONNRESET. Removed here because:
  //   1. StrictMode has zero effect on production builds anyway.
  //   2. Our guacd tunnel is a real external connection, not a pure React side-effect.
  <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <App />
    <Toaster
      position="top-right"
      containerStyle={{ zIndex: 100000 }}
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
)
