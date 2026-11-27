import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import App from './App'
import { NamesProvider } from './names'
import './index.css'
import { wagmiConfig } from './wagmi'

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <NamesProvider>
          <App />
        </NamesProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
