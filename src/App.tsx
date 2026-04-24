import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet'
import { missingSupabaseConfig, supabase } from './lib/supabase'
import './App.css'

type AddressRow = {
  id: string
  full_address: string
  lat: number
  long: number
  canvassed: boolean
}

const FORSYTH_CENTER: [number, number] = [36.103, -80.256]

function App() {
  const [addresses, setAddresses] = useState<AddressRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const validAddresses = useMemo(
    () =>
      addresses.filter(
        (address) =>
          Number.isFinite(address.lat) &&
          Number.isFinite(address.long) &&
          Math.abs(address.lat) <= 90 &&
          Math.abs(address.long) <= 180,
      ),
    [addresses],
  )

  useEffect(() => {
    const fetchAddresses = async () => {
      if (!supabase) {
        setErrorMessage(missingSupabaseConfig)
        setIsLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('addresses')
        .select('id,full_address,lat,long,canvassed')
        .order('full_address', { ascending: true })
        .limit(5000)

      if (error) {
        setErrorMessage(error.message)
      } else {
        setAddresses((data as AddressRow[]) ?? [])
      }

      setIsLoading(false)
    }

    void fetchAddresses()
  }, [])

  const centerPoint = useMemo<[number, number]>(() => {
    if (validAddresses.length === 0) {
      return FORSYTH_CENTER
    }

    const firstAddress = validAddresses[0]
    return [firstAddress.lat, firstAddress.long]
  }, [validAddresses])

  const toggleCanvassed = async (address: AddressRow) => {
    if (!supabase) {
      setErrorMessage(missingSupabaseConfig)
      return
    }

    const nextState = !address.canvassed
    setAddresses((current) =>
      current.map((item) =>
        item.id === address.id ? { ...item, canvassed: nextState } : item,
      ),
    )

    const { error } = await supabase
      .from('addresses')
      .update({ canvassed: nextState })
      .eq('id', address.id)

    if (error) {
      setAddresses((current) =>
        current.map((item) =>
          item.id === address.id ? { ...item, canvassed: address.canvassed } : item,
        ),
      )
      setErrorMessage(error.message)
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <h1>Canvass</h1>
        <p>
          {isLoading
            ? 'Loading addresses...'
            : `${validAddresses.length} addresses loaded`}
        </p>
      </header>

      {errorMessage && <p className="error-banner">{errorMessage}</p>}

      <section className="map-panel">
        <MapContainer center={centerPoint} zoom={12} scrollWheelZoom className="map-view">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {validAddresses.map((address) => (
            <CircleMarker
              key={address.id}
              center={[address.lat, address.long]}
              radius={6}
              pathOptions={{
                color: address.canvassed ? '#2e7d32' : '#b91c1c',
                fillColor: address.canvassed ? '#4caf50' : '#ef5350',
                fillOpacity: 0.9,
                weight: 1,
              }}
            >
              <Popup>
                <p className="popup-address">{address.full_address}</p>
                <button
                  type="button"
                  className="status-button"
                  onClick={() => void toggleCanvassed(address)}
                >
                  {address.canvassed ? 'Mark uncanvassed' : 'Mark canvassed'}
                </button>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </section>
    </main>
  )
}

export default App
