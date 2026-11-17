import { useEffect, useState } from 'react'
import Home from './Home.jsx'
import Host from './Host.jsx'
import Player from './Player.jsx'

const read = () => {
  const [page = '', code = ''] = window.location.hash.replace(/^#\/?/, '').split('/')
  return { page, code: code.toUpperCase() }
}

export default function App() {
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onHash = () => setRoute(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // The key remounts a screen when the room changes, which also resets its socket.
  if (route.page === 'host' && route.code) return <Host key={route.code} code={route.code} />
  if (route.page === 'play' && route.code) return <Player key={route.code} code={route.code} />
  return <Home />
}
