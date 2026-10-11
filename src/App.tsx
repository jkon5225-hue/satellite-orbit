import { useEffect, useRef, useState } from 'react'

import {
  Viewer,
  ArcType,
  Cartesian2,
  Cartesian3,
  Color,
  LabelStyle,
  VerticalOrigin,
  HorizontalOrigin,
  CallbackPositionProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  JulianDate,
  defined,
  Entity,
  HeadingPitchRange,
  Math as CesiumMath,
} from 'cesium'

import * as satellite from 'satellite.js'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const TLE_URL = '/api/celestrak?CATNR=25544&FORMAT=TLE'
const STARLINK_TLE_URL = '/api/celestrak?GROUP=STARLINK&FORMAT=TLE'
const STARLINK_CACHE_KEY = 'starlink-tle-cache-v1'
const STARLINK_CACHE_INTERVAL = 2 * 60 * 60 * 1000

const TLE_CACHE_KEY = 'iss-tle-cache-v1'
const TLE_INTERVAL = 2 * 60 * 60 * 1000

type CachedTle = {
  name: string
  tle1: string
  tle2: string
  fetchedAt: number
}

type SatelliteInfo = {
  name: string
  noradId: string
  tle1: string
  tle2: string
  latitude: number
  longitude: number
  altitude: number
  velocity: number
  calculatedAt: string
}

type SatelliteSatrec = {
  name: string
  satrec: satellite.SatRec
}

let tleFetchPromise: Promise<CachedTle | null> | null = null

function readTleCache(): CachedTle | null {
  try {
    const raw = localStorage.getItem(TLE_CACHE_KEY)
    if (!raw) return null

    const data = JSON.parse(raw) as CachedTle

    if (
      !data.name ||
      !data.tle1?.startsWith('1 ') ||
      !data.tle2?.startsWith('2 ') ||
      !Number.isFinite(data.fetchedAt)
    ) {
      return null
    }

    return data
  } catch {
    return null
  }
}

async function getTle(): Promise<CachedTle> {
  const cached = readTleCache()

  if (cached && Date.now() - cached.fetchedAt < TLE_INTERVAL) {
    return cached
  }

  if (!tleFetchPromise) {
    tleFetchPromise = (async () => {
      try {
        const response = await fetch(TLE_URL)

        if (!response.ok) {
          throw new Error(`TLE取得失敗: HTTP ${response.status}`)
        }

        const text = await response.text()
        const lines = text
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)

        const line1 = lines.find((line) => line.startsWith('1 '))
        const line2 = lines.find((line) => line.startsWith('2 '))

        if (!line1 || !line2) {
          throw new Error('TLEの形式が正しくありません')
        }

        const data: CachedTle = {
          name:
            lines.find(
              (line) => !line.startsWith('1 ') && !line.startsWith('2 ')
            ) || 'ISS (ZARYA)',
          tle1: line1,
          tle2: line2,
          fetchedAt: Date.now(),
        }

        localStorage.setItem(TLE_CACHE_KEY, JSON.stringify(data))

        return data
      } catch (error) {
        const fallback = readTleCache()

        if (fallback) {
          console.warn('TLE更新失敗。保存済みデータを使用します。', error)
          return fallback
        }

        throw error
      }
    })()
  }

  try {
    const result = await tleFetchPromise
    if (!result) throw new Error('TLEを取得できませんでした')
    return result
  } finally {
    tleFetchPromise = null
  }
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const issEntityRef = useRef<Entity | null>(null)
  const orbitEntityRef = useRef<Entity | null>(null)
  const satrecRef = useRef<satellite.SatRec | null>(null)
  const tleRef = useRef<CachedTle | null>(null)

  // Starlink管理用 Ref
  const starlinkSatrecsRef = useRef<SatelliteSatrec[]>([])
  const starlinkEntitiesRef = useRef<Entity[]>([])

  const [status, setStatus] = useState('Cesium起動中...')
  const [satelliteInfo, setSatelliteInfo] = useState<SatelliteInfo | null>(null)

  // Starlink用 State
  const [isStarlinkVisible, setIsStarlinkVisible] = useState(false)
  const [isLoadingStarlink, setIsLoadingStarlink] = useState(false)

  // ISSの軌道と情報パネルの表示をクリアする共通処理
  const clearOrbitAndInfo = () => {
    if (viewerRef.current && orbitEntityRef.current) {
      viewerRef.current.entities.remove(orbitEntityRef.current)
      orbitEntityRef.current = null
    }
    setSatelliteInfo(null)
  }

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let refreshTimer: number | undefined

    const viewer = new Viewer(containerRef.current, {
      animation: true,
      timeline: true,
      baseLayerPicker: true,
      geocoder: false,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: false,
      fullscreenButton: false,
      useBrowserRecommendedResolution: false,
    })

    viewer.resolutionScale = window.devicePixelRatio || 1
    viewerRef.current = viewer

    const resizeObserver = new ResizeObserver(() => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.resize()
      }
    })
    resizeObserver.observe(containerRef.current)

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)

    const calculatePosition = (
      time?: JulianDate
    ): Cartesian3 | undefined => {
      const satrec = satrecRef.current
      if (!satrec || !time) return undefined

      const date = JulianDate.toDate(time)
      const pv = satellite.propagate(satrec, date)

      if (!pv || !pv.position || typeof pv.position === 'boolean') {
        return undefined
      }

      const gmst = satellite.gstime(date)
      const geo = satellite.eciToGeodetic(pv.position, gmst)

      return Cartesian3.fromDegrees(
        satellite.degreesLong(geo.longitude),
        satellite.degreesLat(geo.latitude),
        geo.height * 1000
      )
    }

    const loadTle = async (initial: boolean) => {
      try {
        setStatus(initial ? 'ISSのTLEを確認中...' : 'TLE更新中...')

        const tle = await getTle()
        if (disposed) return

        const satrec = satellite.twoline2satrec(tle.tle1, tle.tle2)

        satrecRef.current = satrec
        tleRef.current = tle

        if (!issEntityRef.current) {
          const issEntity = viewer.entities.add({
            name: tle.name,
            position: new CallbackPositionProperty(
              (time) => calculatePosition(time),
              false
            ),
            point: {
              pixelSize: 14,
              color: Color.RED,
              outlineColor: Color.WHITE,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: 'ISS',
              font: '18px sans-serif',
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 3,
              style: LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: VerticalOrigin.BOTTOM,
              horizontalOrigin: HorizontalOrigin.CENTER,
              pixelOffset: new Cartesian3(0, -18, 0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          })

          issEntityRef.current = issEntity

          const currentTime = viewer.clock.currentTime
          if (!currentTime) {
            throw new Error('Cesiumの現在時刻を取得できません')
          }

          const position = calculatePosition(currentTime)
          if (position) {
            await viewer.flyTo(issEntity, {
              duration: 2,
              offset: new HeadingPitchRange(
                0,
                CesiumMath.toRadians(-90),
                12000000
              ),
            })
          }
        }

        if (disposed) return

        setStatus(
          `ISS表示中 | TLE取得: ${new Date(
            tle.fetchedAt
          ).toLocaleString()}`
        )
      } catch (error) {
        console.error('ISS/TLEエラー:', error)
      }
    }

    // ISSのクリックハンドラ（トグル切り替え）
    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.position)
      const issEntity = issEntityRef.current
      const tle = tleRef.current
      const satrec = satrecRef.current

      if (
        !defined(picked) ||
        !issEntity ||
        picked.id !== issEntity ||
        !tle ||
        !satrec
      ) {
        return
      }

      // トグル判定: すでに表示されている場合はクリアして閉じる
      if (orbitEntityRef.current) {
        clearOrbitAndInfo()
        return
      }

      const now = new Date()
      const pv = satellite.propagate(satrec, now)

      if (!pv || !pv.position || typeof pv.position === 'boolean') {
        return
      }

      const geo = satellite.eciToGeodetic(
        pv.position,
        satellite.gstime(now)
      )

      let velocity = 0
      if (pv.velocity && typeof pv.velocity !== 'boolean') {
        velocity = Math.sqrt(
          pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2
        )
      }

      const orbitPositions: Cartesian3[] = []
      for (let minute = 0; minute <= 100; minute += 1) {
        const orbitTime = new Date(now.getTime() + minute * 60 * 1000)
        const orbitPv = satellite.propagate(satrec, orbitTime)

        if (
          !orbitPv ||
          !orbitPv.position ||
          typeof orbitPv.position === 'boolean'
        ) {
          continue
        }

        const orbitGeo = satellite.eciToGeodetic(
          orbitPv.position,
          satellite.gstime(orbitTime)
        )

        orbitPositions.push(
          Cartesian3.fromDegrees(
            satellite.degreesLong(orbitGeo.longitude),
            satellite.degreesLat(orbitGeo.latitude),
            orbitGeo.height * 1000
          )
        )
      }

      if (orbitPositions.length >= 2) {
        const orbitEntity = viewer.entities.add({
          name: 'ISS軌道（今後約100分）',
          polyline: {
            positions: orbitPositions,
            width: 3,
            material: Color.CYAN,
            arcType: ArcType.NONE,
          },
        })

        orbitEntityRef.current = orbitEntity

        void viewer.flyTo([issEntity, orbitEntity], {
          duration: 1.5,
          offset: new HeadingPitchRange(
            0,
            CesiumMath.toRadians(-90),
            0
          ),
        })
      }

      setSatelliteInfo({
        name: tle.name,
        noradId: '25544',
        tle1: tle.tle1,
        tle2: tle.tle2,
        latitude: satellite.degreesLat(geo.latitude),
        longitude: satellite.degreesLong(geo.longitude),
        altitude: geo.height,
        velocity,
        calculatedAt: now.toLocaleString(),
      })
    }, ScreenSpaceEventType.LEFT_CLICK)

    void loadTle(true)

    refreshTimer = window.setInterval(() => {
      void loadTle(false)
    }, TLE_INTERVAL)

    return () => {
      disposed = true

      if (refreshTimer !== undefined) {
        window.clearInterval(refreshTimer)
      }

      resizeObserver.disconnect()
      handler.destroy()

      if (!viewer.isDestroyed()) {
        viewer.destroy()
      }

      viewerRef.current = null
      issEntityRef.current = null
      orbitEntityRef.current = null
    }
  }, [])

  // Starlink衛星の一括表示/非表示トグル処理（修正版）
  const toggleStarlink = async () => {
    const viewer = viewerRef.current
    if (!viewer) return

    // すでに表示中の場合は非表示にして削除
    if (isStarlinkVisible) {
      starlinkEntitiesRef.current.forEach((entity) => {
        viewer.entities.remove(entity)
      })
      starlinkEntitiesRef.current = []
      setIsStarlinkVisible(false)
      return
    }

    // TLEデータがまだ無ければ、キャッシュを優先して取得
    if (starlinkSatrecsRef.current.length === 0) {
      setIsLoadingStarlink(true)

      try {
        let tleText = ''
        let cachedData: { text: string; fetchedAt: number } | null = null

        // 保存済みTLEを読み込む（期限切れでも取得失敗時の予備として保持）
        const cachedRaw = localStorage.getItem(STARLINK_CACHE_KEY)
        if (cachedRaw) {
          try {
            const parsed = JSON.parse(cachedRaw) as {
              text?: unknown
              fetchedAt?: unknown
            }
            if (
              typeof parsed.text === 'string' &&
              typeof parsed.fetchedAt === 'number' &&
              parsed.text.includes('\n1 ') &&
              parsed.text.includes('\n2 ')
            ) {
              cachedData = {
                text: parsed.text,
                fetchedAt: parsed.fetchedAt,
              }
            }
          } catch {
            localStorage.removeItem(STARLINK_CACHE_KEY)
          }
        }

        // 2時間以内のキャッシュがあれば、CelesTrakへ再アクセスしない
        if (
          cachedData &&
          Date.now() - cachedData.fetchedAt < STARLINK_CACHE_INTERVAL
        ) {
          tleText = cachedData.text
          console.log('保存済みStarlink TLEを使用します')
        } else {
          const response = await fetch(STARLINK_TLE_URL)
          const responseText = await response.text()

          console.log('Starlink HTTP status:', response.status)
          console.log('Starlink response preview:', responseText.slice(0, 300))

          if (!response.ok) {
            // CelesTrakが403等を返した場合、期限切れでも保存済みデータがあれば利用
            if (cachedData) {
              tleText = cachedData.text
              console.warn(
                `Starlink TLE更新失敗（HTTP ${response.status}）。保存済みデータを使用します。`
              )
            } else {
              throw new Error(
                `HTTP ${response.status}: ${responseText.slice(0, 200)}\n` +
                '保存済みTLEもありません。CelesTrakの取得制限が解除されてから再試行してください。'
              )
            }
          } else if (
            responseText.trimStart().startsWith('<!doctype') ||
            responseText.trimStart().startsWith('<html')
          ) {
            throw new Error('TLEではなくHTMLが返されました。Viteプロキシ設定を確認してください。')
          } else {
            tleText = responseText
            localStorage.setItem(
              STARLINK_CACHE_KEY,
              JSON.stringify({ text: tleText, fetchedAt: Date.now() })
            )
          }
        }

        const lines = tleText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)

        const satrecs: SatelliteSatrec[] = []

        // 行1と行2をペアにして衛星データを抽出
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].startsWith('1 ') && lines[i + 1].startsWith('2 ')) {
            const line1 = lines[i]
            const line2 = lines[i + 1]
            const name =
              i > 0 &&
              !lines[i - 1].startsWith('1 ') &&
              !lines[i - 1].startsWith('2 ')
                ? lines[i - 1]
                : `STARLINK-${satrecs.length + 1}`

            try {
              const satrec = satellite.twoline2satrec(line1, line2)
              if (Number.isFinite(satrec.no) && satrec.no > 0) {
                satrecs.push({ name, satrec })
              }
            } catch {
              // 形式が不正なTLEはスキップ
            }
            i++
          }
        }

        if (satrecs.length === 0) {
          throw new Error(
            `有効なStarlink TLEデータがありません。応答先頭: ${tleText.slice(0, 200)}`
          )
        }

        console.log(`Starlink TLE取得成功: ${satrecs.length}基`)
        starlinkSatrecsRef.current = satrecs
      } catch (error) {
        console.error('Starlink TLE取得エラー:', error)
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`Starlink取得失敗: ${message}`)
        alert(`Starlink TLE取得失敗:\n${message}`)
        return
      } finally {
        setIsLoadingStarlink(false)
      }
    }

    // 時刻連動の位置計算関数
    const calcPosition = (satrec: satellite.SatRec, time?: JulianDate) => {
      if (!time) return undefined
      const date = JulianDate.toDate(time)
      const pv = satellite.propagate(satrec, date)
      if (!pv || !pv.position || typeof pv.position === 'boolean') return undefined

      const gmst = satellite.gstime(date)
      const geo = satellite.eciToGeodetic(pv.position, gmst)
      return Cartesian3.fromDegrees(
        satellite.degreesLong(geo.longitude),
        satellite.degreesLat(geo.latitude),
        geo.height * 1000
      )
    }

    // エンティティをまとめて生成・追加
    const newEntities: Entity[] = []
    
    // Cesium描画バッチ（パフォーマンス最適化）
    viewer.entities.suspendEvents()

    starlinkSatrecsRef.current.forEach((item) => {
      const entity = viewer.entities.add({
        name: item.name,
        position: new CallbackPositionProperty(
          (time) => calcPosition(item.satrec, time),
          false
        ),
        point: {
          pixelSize: 3,
          color: Color.YELLOW,
          outlineColor: Color.BLACK,
          outlineWidth: 0.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      newEntities.push(entity)
    })

    viewer.entities.resumeEvents()

    starlinkEntitiesRef.current = newEntities
    setIsStarlinkVisible(true)
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: 0,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* ステータス表示 */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          padding: '8px 12px',
          background: 'rgba(0,0,0,0.8)',
          color: 'white',
          borderRadius: 5,
          fontSize: 13,
          zIndex: 1000,
          maxWidth: '70vw',
        }}
      >
        {status}
      </div>

      {/* Starlink トグルボタン */}
      <button
        onClick={toggleStarlink}
        disabled={isLoadingStarlink}
        style={{
          position: 'absolute',
          top: 50,
          left: 10,
          padding: '8px 16px',
          background: isStarlinkVisible ? '#aa3bff' : 'rgba(0,0,0,0.8)',
          color: 'white',
          border: '1px solid rgba(255,255,255,0.4)',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 'bold',
          cursor: 'pointer',
          zIndex: 1000,
          transition: 'all 0.2s ease',
        }}
      >
        {isLoadingStarlink
          ? '📡 Starlink 読み込み中...'
          : isStarlinkVisible
          ? '🛰️ Starlink 表示中 (Clickで非表示)'
          : '📡 Starlink 一括表示'}
      </button>

      {/* ISS情報パネル */}
      {satelliteInfo && (
        <div
          style={{
            position: 'absolute',
            top: 60,
            right: 20,
            width: 340,
            maxWidth: 'calc(100vw - 40px)',
            maxHeight: '80vh',
            overflowY: 'auto',
            padding: 18,
            background: 'rgba(20,20,30,0.96)',
            color: 'white',
            borderRadius: 10,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            zIndex: 2000,
            fontFamily: 'Arial, sans-serif',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 20 }}>
              🛰️ {satelliteInfo.name}
            </h2>

            <button
              onClick={clearOrbitAndInfo}
              aria-label="情報パネルを閉じる"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'white',
                fontSize: 24,
                cursor: 'pointer',
              }}
            >
              ×
            </button>
          </div>

          <hr />

          <p>
            <strong>NORAD ID:</strong> {satelliteInfo.noradId}
          </p>
          <p>
            <strong>緯度:</strong> {satelliteInfo.latitude.toFixed(3)}°
          </p>
          <p>
            <strong>経度:</strong> {satelliteInfo.longitude.toFixed(3)}°
          </p>
          <p>
            <strong>高度:</strong> {satelliteInfo.altitude.toFixed(1)} km
          </p>
          <p>
            <strong>速度:</strong> {satelliteInfo.velocity.toFixed(3)} km/s
          </p>
          <p>
            <strong>計算時刻:</strong> {satelliteInfo.calculatedAt}
          </p>

          <hr />
          <strong>TLE（軌道要素）</strong>
          <pre
            style={{
              fontSize: 10,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {satelliteInfo.tle1}
            {'\n'}
            {satelliteInfo.tle2}
          </pre>
        </div>
      )}
    </div>
  )
}

export default App