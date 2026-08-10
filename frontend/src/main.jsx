import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './i18n'
import { ThemeProvider } from './context/ThemeContext'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={null}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </Suspense>
  </StrictMode>,
)
