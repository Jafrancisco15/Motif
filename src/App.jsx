import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Chart, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale } from 'chart.js'
Chart.register(LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale)

const DEFAULT_SERVICE = '1bc50001-0200-0aa5-e311-24cb004a98c5'
const DEFAULT_CHAR = '1bc50002-0200-0aa5-e311-24cb004a98c5'

function decodeRawMg(dv){ return dv.getInt32(0,true) }
function useLocalStorage(key, initial) {
  const [state, setState] = useState(() => {
    try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : initial } catch { return initial }
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

  const [profiles,setProfiles]=useLocalStorage('mentor.profiles', {})
  const [currentProfile,setCurrentProfile]=useLocalStorage('mentor.currentProfile', 'default')
  const [scale,setScale]=useLocalStorage(`mentor.${currentProfile}.scale`, 0.001)
  const [zeroRaw,setZeroRaw]=useLocalStorage(`mentor.${currentProfile}.zeroRaw`, 0)

  const [absG,setAbsG]=useState(0), [netG,setNetG]=useState(0), [flowGps,setFlowGps]=useState(0)
  const [samples,setSamples]=useState([]) // {t, g}
  const [running,setRunning]=useState(false)

  const charRef=useRef(null), deviceRef=useRef(null)
  const startTimeRef=useRef(null), lastSampleRef=useRef(null)

  useEffect(()=>{
    // Load persisted scale/zero when profile changes
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
      deviceRef.current=device; device.addEventListener('gattserverdisconnected', onDisconnect)
      const server=await device.gatt.connect(); const service=await server.getPrimaryService(serviceUUID)
      const characteristic=await service.getCharacteristic(charUUID)
      charRef.current=characteristic; setDeviceName(device.name||'—'); setConnected(true)
    }catch(err){ setErrorMsg(err?.message||String(err)) } finally{ setConnecting(false) }
  }

  async function start(){
    if(!charRef.current) return
    setRunning(true); setSamples([]); setFlowGps(0); startTimeRef.current=performance.now(); lastSampleRef.current=null
    const onNotify=(event)=>{
      const dv=new DataView(event.target.value.buffer)
      const raw=decodeRawMg(dv)
      const abs = raw*scale
      const net = (raw-zeroRaw)*scale
      setAbsG(abs); setNetG(net)

      const t=(performance.now()-startTimeRef.current)/1000
      const last=lastSampleRef.current; let flow=0
      if(last){ const dt=Math.max(1e-3,t-last.t); flow=(net-last.g)/dt } // dt min 1ms
      lastSampleRef.current={t,g:net}; setFlowGps(flow)
      setSamples(prev=>[...prev,{t,g:net}])
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

  function zeroNow(){ const rawEst=Math.round(absG/scale); setZeroRaw(rawEst) }

  function spanCal(knownG){
    const rawEst=Math.round(absG/scale); const delta=rawEst-zeroRaw
    if(Math.abs(delta)<1) return alert('Coloca un peso de referencia y reintenta.')
    const newScale=knownG/delta; setScale(newScale); alert(`Nuevo scale = ${newScale.toPrecision(6)} g/u`)
  }

  function saveProfile(name){
    if(!name) return alert('Nombre vacío.')
    const updated={...profiles}; updated[name]={scale, zeroRaw, savedAt:new Date().toISOString()}
    setProfiles(updated); localStorage.setItem(`mentor.${name}.scale`, JSON.stringify(scale)); localStorage.setItem(`mentor.${name}.zeroRaw`, JSON.stringify(zeroRaw)); setCurrentProfile(name)
  }
  function loadProfile(name){ const r=profiles[name]; if(r){ setScale(r.scale); setZeroRaw(r.zeroRaw); setCurrentProfile(name) } }
  function deleteProfile(name){ if(!name||name==='default') return; const u={...profiles}; delete u[name]; setProfiles(u); localStorage.removeItem(`mentor.${name}.scale`); localStorage.removeItem(`mentor.${name}.zeroRaw`); if(currentProfile===name) setCurrentProfile('default') }

  // 1 Hz export: weight and flow per whole second
  function exportCSV1Hz(){
    if(samples.length===0) return
    const secondsMax = Math.floor(samples[samples.length-1].t)
    const perSec = []
    let idx=0
    let prevW = null
    for(let s=0; s<=secondsMax; s++){
      // find last sample at or before this second
      while(idx < samples.length && samples[idx].t <= s) idx++
      const k = Math.max(0, idx-1)
      const w = samples[k]?.g ?? 0
      let flow = 0
      if(prevW!==null) flow = w - prevW // /1s
      prevW = w
      perSec.push({ second: s, weight_g: w, flow_gps: flow })
    }
    const header='second,weight_g,flow_gps\n'
    const rows=perSec.map(r=>`${r.second},${r.weight_g.toFixed(3)},${r.flow_gps.toFixed(3)}`).join('\n')
    const blob=new Blob([header+rows],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a')
    a.href=url; a.download='espresso_profile_1hz.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const chartData=useMemo(()=>({ 
    labels:samples.map(s=>s.t),
    datasets:[{
      label:'Peso neto (g)',
      data:samples.map(s=>({x:s.t, y:s.g})),
      borderColor:'yellow',
      borderWidth:2,
      pointRadius:0,
      fill:false,
      tension:0.08
    }]
  }),[samples])

  const chartOptions=useMemo(()=>({ 
    responsive:true,
    animation:false,
    normalized:true,
    parsing:false,
    maintainAspectRatio:false,
    plugins:{ legend:{display:false}, tooltip:{mode:'index',intersect:false} },
    scales:{
      x:{ type:'linear', title:{display:true,text:'Tiempo (s)'}, ticks:{ maxTicksLimit:10 } },
      y:{ title:{display:true,text:'g'}, beginAtZero:false }
    }
  }),[])

  return (<div className="container"><div className="card">
    <div className="row" style={{justifyContent:'space-between'}}>
      <h2 style={{margin:0}}>Mentor Coffee Scale • Web Bluetooth (v5)</h2>
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
        <button onClick={exportCSV1Hz} disabled={samples.length===0}>Exportar CSV 1Hz (g y g/s)</button>
      </div>
      <div className="small" style={{marginTop:8}}>
        El CSV 1Hz contiene <b>peso</b> y <b>flujo</b> por cada segundo (flow = Δpeso/1s). La gráfica es línea <b>amarilla</b>, sin relleno, con autoescala vertical.
      </div>
    </div>

    <div style={{marginTop:16, height:300}}><Line data={chartData} options={chartOptions}/></div>

    <div className="footer">HTTPS + Chrome/Edge. Android: habilita Ubicación y Dispositivos cercanos para Chrome.</div>
  </div></div>)
}
