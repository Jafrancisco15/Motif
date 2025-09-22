import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Chart, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale } from 'chart.js'

Chart.register(LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale)

const DEFAULT_SERVICE = '1bc50001-0200-0aa5-e311-24cb004a98c5'
const DEFAULT_CHAR = '1bc50002-0200-0aa5-e311-24cb004a98c5'

function decodeRawMg(dv){ return dv.getInt32(0,true) }

function useLocalStorage(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v !== null ? JSON.parse(v) : initial
    } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(state)) } catch {} }, [key, state])
  return [state, setState]
}

export default function App(){
  const [serviceUUID,setServiceUUID]=useState(DEFAULT_SERVICE)
  const [charUUID,setCharUUID]=useState(DEFAULT_CHAR)
  const [acceptAll,setAcceptAll]=useState(true)
  const [connected,setConnected]=useState(false)
  const [connecting,setConnecting]=useState(false)
  const [deviceName,setDeviceName]=useState('')
  const [errorMsg,setErrorMsg]=useState('')

  // Calibration profiles
  const [profiles,setProfiles]=useLocalStorage('mentor.profiles', {})
  const [currentProfile,setCurrentProfile]=useLocalStorage('mentor.currentProfile', 'default')
  const [scale,setScale]=useLocalStorage(`mentor.${currentProfile}.scale`, 0.001)
  const [zeroRaw,setZeroRaw]=useLocalStorage(`mentor.${currentProfile}.zeroRaw`, 0)
  const [tareApplied,setTareApplied]=useState(false)
  const [tareValueG,setTareValueG]=useState(0)
  const [tareTime,setTareTime]=useState(null)

  // Readouts
  const [absG,setAbsG]=useState(0) // before tare
  const [netG,setNetG]=useState(0) // after tare
  const [flowGps,setFlowGps]=useState(0)
  const [samples,setSamples]=useState([])
  const [running,setRunning]=useState(false)

  const charRef=useRef(null), deviceRef=useRef(null)
  const startTimeRef=useRef(null), lastSampleRef=useRef(null)
  const smoothRef=useRef({ buffer:[], durationMs:300, baseRaw:null })

  useEffect(()=>{
    // When profile changes, rebind scale/zero from localStorage
    const s = JSON.parse(localStorage.getItem(`mentor.${currentProfile}.scale`)||'0.001')
    const z = JSON.parse(localStorage.getItem(`mentor.${currentProfile}.zeroRaw`)||'0')
    setScale(s||0.001); setZeroRaw(z||0)
  }, [currentProfile])

  const onDisconnect=()=>{ setConnected(false); setRunning(false); charRef.current=null; deviceRef.current=null }

  async function connect(){
    try{
      setErrorMsg(''); setConnecting(true)
      let device
      if(acceptAll){ device=await navigator.bluetooth.requestDevice({ acceptAllDevices:true, optionalServices:[serviceUUID] }) }
      else { device=await navigator.bluetooth.requestDevice({ filters:[{namePrefix:'MOTIF'},{namePrefix:'Mentor'}], optionalServices:[serviceUUID] }) }
      deviceRef.current=device
      device.addEventListener('gattserverdisconnected', onDisconnect)
      const server=await device.gatt.connect()
      const service=await server.getPrimaryService(serviceUUID)
      const characteristic=await service.getCharacteristic(charUUID)
      charRef.current=characteristic
      setDeviceName(device.name||'—'); setConnected(true)
    }catch(err){ setErrorMsg(err?.message||String(err)) } finally{ setConnecting(false) }
  }

  async function start(){
    if(!charRef.current) return
    setRunning(true); setSamples([]); setFlowGps(0); startTimeRef.current=performance.now(); lastSampleRef.current=null
    smoothRef.current={buffer:[], durationMs:300, baseRaw:null}
    setTareApplied(false); setTareValueG(0); setTareTime(null)

    const onNotify=(event)=>{
      const dv=new DataView(event.target.value.buffer)
      const raw=decodeRawMg(dv)
      const now=performance.now()

      // absolute before tare
      const abs = raw * scale
      setAbsG(abs)

      // use zeroRaw for tare
      const net = (raw - zeroRaw) * scale
      setNetG(net)

      if(!tareApplied){
        setTareApplied(true)
        setTareValueG(abs)  // what we substract logically as tare (abs at start)
        setTareTime(new Date().toISOString())
      }

      const t=(now - startTimeRef.current)/1000
      const last=lastSampleRef.current; let flow=0; if(last){ const dt=Math.max(1e-6, t-last.t); flow=(net-last.g)/dt }
      lastSampleRef.current={t, g: net}
      setFlowGps(flow)
      setSamples(prev=>[...prev,{t, g: net}])
    }

    await charRef.current.startNotifications()
    charRef.current.addEventListener('characteristicvaluechanged', onNotify)
  }

  async function stop(){
    if(charRef.current){
      try{ await charRef.current.stopNotifications() }catch{}
      try{ charRef.current.removeEventListener('characteristicvaluechanged', ()=>{}) }catch{}
    }
    setRunning(false)
  }

  async function disconnect(){ await stop(); try{ deviceRef.current?.gatt?.disconnect() }catch{}; setConnected(false) }

  function zeroNow(){
    // set zeroRaw from current absolute reading
    const rawEst=Math.round(absG/scale)
    setZeroRaw(rawEst)
    setTareApplied(true); setTareValueG(absG); setTareTime(new Date().toISOString())
  }

  function spanCal(knownG){
    const rawEst=Math.round(absG/scale)
    const delta=rawEst - zeroRaw
    if(Math.abs(delta)<1){ alert('Coloca un peso de referencia y vuelve a intentar.'); return }
    const newScale = knownG / delta
    setScale(newScale)
    alert(`Calibración guardada. scale=${newScale.toPrecision(6)} g/u`)
  }

  function saveProfile(name){
    if(!name) return alert('Escribe un nombre.')
    const updated={...profiles}
    updated[name]={ scale, zeroRaw, savedAt: new Date().toISOString() }
    setProfiles(updated)
    localStorage.setItem(`mentor.${name}.scale`, JSON.stringify(scale))
    localStorage.setItem(`mentor.${name}.zeroRaw`, JSON.stringify(zeroRaw))
    setCurrentProfile(name)
  }

  function loadProfile(name){
    if(!name) return
    const rec = profiles[name]
    if(rec){
      setScale(rec.scale); setZeroRaw(rec.zeroRaw); setCurrentProfile(name)
    }
  }

  function deleteProfile(name){
    if(!name || name==='default') return
    const updated={...profiles}; delete updated[name]; setProfiles(updated)
    localStorage.removeItem(`mentor.${name}.scale`); localStorage.removeItem(`mentor.${name}.zeroRaw`)
    if(currentProfile===name) setCurrentProfile('default')
  }

  const chartData=useMemo(()=>({ labels:samples.map(s=>s.t.toFixed(2)), datasets:[{label:'Peso neto (g)', data:samples.map(s=>s.g), fill:true, tension:0.15}] }),[samples])
  const chartOptions=useMemo(()=>({ responsive:true, animation:false, plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}}, scales:{ x:{title:{display:true,text:'Tiempo (s)'},ticks:{maxTicksLimit:8}}, y:{title:{display:true,text:'g'}} } }),[])

  function downloadCSV(){
    const header='t_s,peso_neto_g\n'
    const rows=samples.map(s=>`${s.t.toFixed(3)},${s.g.toFixed(3)}`).join('\n')
    const blob=new Blob([header+rows],{type:'text/csv'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='espresso_weight_timeseries.csv'; a.click(); URL.revokeObjectURL(url)
  }

  return (<div className="container"><div className="card">
    <div className="row" style={{justifyContent:'space-between'}}>
      <h2 style={{margin:0}}>Mentor Coffee Scale • Web Bluetooth (v4)</h2>
      <span className="pill">{connected?'Conectado':'Desconectado'}</span>
    </div>

    <div className="row" style={{marginTop:12}}>
      <input type="text" value={serviceUUID} onChange={e=>setServiceUUID(e.target.value)} style={{flex:'1 1 280px'}} placeholder="Service UUID"/>
      <input type="text" value={charUUID} onChange={e=>setCharUUID(e.target.value)} style={{flex:'1 1 280px'}} placeholder="Characteristic UUID"/>
      <label><input type="checkbox" checked={acceptAll} onChange={e=>setAcceptAll(e.target.checked)}/> Mostrar todos</label>
      <button className="primary" disabled={connecting||connected} onClick={connect}>{connecting?'Escaneando…':'Conectar'}</button>
      <button onClick={disconnect} disabled={!connected}>Desconectar</button>
    </div>

    {errorMsg && <div className="error" style={{marginTop:12}}>Error: {errorMsg}</div>}

    <div className="grid" style={{marginTop:16}}>
      <div className="card" style={{padding:'16px'}}>
        <div className="sub">Peso neto (con tare)</div>
        <div className="metric">{netG.toFixed(2)} <span className="sub">g</span></div>
        <div className="sub">Flow (dW/dt): {flowGps.toFixed(2)} g/s</div>
      </div>
      <div className="card" style={{padding:'16px'}}>
        <div className="sub">Peso absoluto (antes de tare)</div>
        <div className="metric-sm">{absG.toFixed(2)} <span className="sub">g</span></div>
        <div className="sub">Tare aplicado: {tareApplied ? <span className="ok">sí</span> : <span className="warn">no</span>}</div>
        <div className="sub">Valor de tare: <span className="kbd">{tareValueG.toFixed(2)} g</span> {tareTime && <span className="small">({new Date(tareTime).toLocaleTimeString()})</span>}</div>
        <div className="sub">zeroRaw: <span className="kbd">{zeroRaw}</span> • scale: <span className="kbd">{scale}</span> g/u • perfil: <span className="kbd">{currentProfile}</span></div>
      </div>
    </div>

    <div className="section card">
      <div className="row" style={{alignItems:'flex-end'}}>
        <button onClick={()=>setSamples([])} disabled={!connected}>Reset curva</button>
        <button className="primary" onClick={()=>start()} disabled={!connected||running}>Start</button>
        <button onClick={()=>stop()} disabled={!running}>Stop</button>
        <button onClick={zeroNow} disabled={!connected}>Zero ahora</button>
        <div className="row">
          <input id="refw" type="number" step="0.1" placeholder="Peso de referencia (g)" style={{width:220}} />
          <button onClick={()=>{ const el=document.getElementById('refw'); const v=parseFloat(el.value); if(!isFinite(v)||v<=0) return alert('Valor inválido.'); spanCal(v) }} disabled={!connected}>Calibrar span</button>
        </div>
        <button onClick={downloadCSV} disabled={samples.length===0}>Exportar CSV</button>
      </div>
      <div className="small" style={{marginTop:8}}>Flujo: derivada del peso neto. Haz <b>Zero ahora</b> con la taza vacía; luego calibra con un peso conocido para ajustar <i>scale</i>.</div>
    </div>

    <div className="section card">
      <div className="row">
        <select value={currentProfile} onChange={e=>loadProfile(e.target.value)}>
          <option value={currentProfile}>{currentProfile}</option>
          {Object.keys(profiles).filter(p=>p!==currentProfile).map(p=>(<option key={p} value={p}>{p}</option>))}
        </select>
        <input type="text" id="pname" placeholder="Nombre de perfil (ej. Taza A)" style={{width:240}} />
        <button onClick={()=>{ const n=document.getElementById('pname').value.trim(); saveProfile(n) }}>Guardar perfil</button>
        <button onClick={()=>{ const n=currentProfile; if(n==='default') return alert('No puedes borrar el perfil default'); if(confirm('¿Borrar perfil '+n+'?')) deleteProfile(n) }}>Borrar perfil actual</button>
      </div>
      <div className="small" style={{marginTop:6}}>Cada perfil guarda <b>zeroRaw</b> y <b>scale</b> (por ejemplo, para diferentes tazas o posiciones).</div>
    </div>

    <div style={{marginTop:16}}><Line data={chartData} options={chartOptions} height={120}/></div>

    <div className="footer">HTTPS + Chrome/Edge. Android: habilita Ubicación y Dispositivos cercanos para Chrome.</div>
  </div></div>)
}
