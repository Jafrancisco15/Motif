import React, { useMemo, useRef, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Chart, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale } from 'chart.js'
Chart.register(LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale)
const DEFAULT_SERVICE = '1bc50001-0200-0aa5-e311-24cb004a98c5'
const DEFAULT_CHAR = '1bc50002-0200-0aa5-e311-24cb004a98c5'
function decodeInt32LEtoGrams(dataView){ const mg=dataView.getInt32(0,true); return mg/1000 }
export default function App(){
  const [serviceUUID,setServiceUUID]=useState(DEFAULT_SERVICE)
  const [charUUID,setCharUUID]=useState(DEFAULT_CHAR)
  const [acceptAll,setAcceptAll]=useState(true)
  const [connected,setConnected]=useState(false)
  const [connecting,setConnecting]=useState(false)
  const [deviceName,setDeviceName]=useState('')
  const [currentG,setCurrentG]=useState(0)
  const [flowGps,setFlowGps]=useState(0)
  const [baselineAbs,setBaselineAbs]=useState(null)
  const [running,setRunning]=useState(false)
  const [samples,setSamples]=useState([])
  const [errorMsg,setErrorMsg]=useState('')
  const startTimeRef=useRef(null), lastSampleRef=useRef(null), charRef=useRef(null), deviceRef=useRef(null), abortRef=useRef(null)
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
      setDeviceName(device.name||'Unknown'); setConnected(true)
    }catch(err){ setErrorMsg(err?.message||String(err)) } finally{ setConnecting(false) }
  }
  async function start(){
    if(!charRef.current) return
    setRunning(true); setSamples([]); setFlowGps(0); startTimeRef.current=performance.now(); lastSampleRef.current=null; setBaselineAbs(null)
    const onNotify=(event)=>{
      const dv=new DataView(event.target.value.buffer)
      const absoluteG=decodeInt32LEtoGrams(dv)
      let base=baselineAbs; if(base===null){ base=absoluteG; setBaselineAbs(base) }
      const g=absoluteG-base; const t=(performance.now()-startTimeRef.current)/1000
      const last=lastSampleRef.current; let flow=0; if(last){ const dt=Math.max(1e-6, t-last.t); flow=(g-last.g)/dt }
      lastSampleRef.current={t,g}; setCurrentG(g); setFlowGps(flow); setSamples(prev=>[...prev,{t,g}])
    }
    await charRef.current.startNotifications()
    charRef.current.addEventListener('characteristicvaluechanged', onNotify)
    abortRef.current=()=>{ try{ charRef.current.stopNotifications() }catch{}; charRef.current?.removeEventListener('characteristicvaluechanged', onNotify) }
  }
  function tareNow(){ setBaselineAbs(prev => (prev===null?0:prev+currentG)) }
  function stop(){ if(abortRef.current) abortRef.current(); setRunning(false) }
  async function disconnect(){ stop(); try{ deviceRef.current?.gatt?.disconnect() }catch{}; setConnected(false) }
  const chartData=useMemo(()=>({ labels:samples.map(s=>s.t.toFixed(2)), datasets:[{label:'Peso (g)', data:samples.map(s=>s.g), fill:true, tension:0.15}] }),[samples])
  const chartOptions=useMemo(()=>({ responsive:true, animation:false, plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}}, scales:{ x:{title:{display:true,text:'Tiempo (s)'},ticks:{maxTicksLimit:8}}, y:{title:{display:true,text:'g'}} } }),[])
  function downloadCSV(){ const header='t_s,peso_g\n'; const rows=samples.map(s=>`${s.t.toFixed(3)},${s.g.toFixed(3)}`).join('\n'); const blob=new Blob([header+rows],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='espresso_weight_timeseries.csv'; a.click(); URL.revokeObjectURL(url) }
  return (<div className="container"><div className="card">
    <div className="row" style={{justifyContent:'space-between'}}><h2 style={{margin:0}}>Mentor Coffee Scale • Web Bluetooth</h2><span className="pill">{connected?'Conectado':'Desconectado'}</span></div>
    <div style={{height:12}}/>
    <div className="row">
      <input type="text" value={serviceUUID} onChange={e=>setServiceUUID(e.target.value)} style={{flex:'1 1 300px'}} placeholder="Service UUID"/>
      <input type="text" value={charUUID} onChange={e=>setCharUUID(e.target.value)} style={{flex:'1 1 300px'}} placeholder="Characteristic UUID"/>
      <label><input type="checkbox" checked={acceptAll} onChange={e=>setAcceptAll(e.target.checked)}/> Mostrar todos (acceptAllDevices)</label>
      <button className="primary" disabled={connecting||connected} onClick={connect}>{connecting?'Escaneando…':'Conectar'}</button>
      <button onClick={disconnect} disabled={!connected}>Desconectar</button>
    </div>
    {errorMsg && <div style={{height:12}}/>}{errorMsg && <div className="error">Error: {errorMsg}</div>}
    <div style={{height:16}}/>
    <div className="grid">
      <div className="card" style={{padding:'16px'}}><div className="sub">Peso actual</div><div className="metric">{currentG.toFixed(2)} <span className="sub">g</span></div><div className="sub">Flow (dW/dt): {flowGps.toFixed(2)} g/s</div></div>
      <div className="card" style={{padding:'16px'}}><div className="sub">Dispositivo</div><div style={{fontWeight:700}}>{deviceName||'—'}</div><div className="sub">Service: {serviceUUID}</div><div className="sub">Char: {charUUID}</div></div>
    </div>
    <div style={{height:16}}/>
    <Line data={chartData} options={chartOptions} height={120}/>
    <div style={{height:16}}/>
    <div className="row">
      <button className="primary" onClick={start} disabled={!connected||running}>Start</button>
      <button onClick={stop} disabled={!running}>Stop</button>
      <button onClick={tareNow} disabled={!connected}>Tare (software)</button>
      <button onClick={downloadCSV} disabled={samples.length===0}>Exportar CSV</button>
    </div>
    <div className="footer">Android: activa <b>Ubicación</b> en el sistema y el permiso de <b>Dispositivos cercanos</b> para Chrome. Si no aparece el nombre, usa <b>Mostrar todos</b>.</div>
  </div></div>) }