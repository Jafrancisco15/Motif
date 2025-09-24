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
  const [elapsed,setElapsed]=useState(0)
  const [extractionInfo,setExtractionInfo]=useState({active:false,duration:0,lastDuration:0})

  const charRef=useRef(null), deviceRef=useRef(null)
  const notifyHandlerRef=useRef(null)
  const startTimeRef=useRef(null), lastSampleRef=useRef(null)
  const smoothRef=useRef({ net:[], abs:[], durationMs:300, skipUntil:0 })
  const extractionRef=useRef({ baseline:0, hasBaseline:false, active:false, start:0, lastRiseTime:0, lastRiseWeight:0 })
  const chartRef=useRef(null)

  useEffect(()=>{
    // When profile changes, rebind scale/zero from localStorage
    const s = JSON.parse(localStorage.getItem(`mentor.${currentProfile}.scale`)||'0.001')
    const z = JSON.parse(localStorage.getItem(`mentor.${currentProfile}.zeroRaw`)||'0')
    setScale(s||0.001); setZeroRaw(z||0)
  }, [currentProfile])

  const onDisconnect=()=>{
    stop()
    setConnected(false)
    setSamples([])
    setElapsed(0)
    setFlowGps(0)
    notifyHandlerRef.current=null
    charRef.current=null
    deviceRef.current=null
    extractionRef.current={ baseline:0, hasBaseline:false, active:false, start:0, lastRiseTime:0, lastRiseWeight:0 }
    setExtractionInfo({active:false,duration:0,lastDuration:0})
  }

  useEffect(()=>{ return ()=>{ stop() } },[])

  function resetCaptureState(){
    startTimeRef.current=performance.now()
    lastSampleRef.current=null
    smoothRef.current={ net:[], abs:[], durationMs:300, skipUntil:0 }
    extractionRef.current={ baseline:netG, hasBaseline:true, active:false, start:0, lastRiseTime:0, lastRiseWeight:netG }
    setSamples([])
    setFlowGps(0)
    setElapsed(0)
    setExtractionInfo(prev=>({active:false,duration:0,lastDuration:prev.lastDuration}))
  }

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
      setDeviceName(device.name||'—')
      setConnected(true)
      await start()
    }catch(err){
      onDisconnect()
      setErrorMsg(err?.message||String(err))
      try{ deviceRef.current?.gatt?.disconnect() }catch{}
    } finally{ setConnecting(false) }
  }

  async function start(){
    if(!charRef.current) return
    resetCaptureState()
    setTareApplied(false); setTareValueG(0); setTareTime(null)
    setRunning(true)

    if(notifyHandlerRef.current){
      return
    }

    const onNotify=(event)=>{
      const dv=new DataView(event.target.value.buffer)
      const raw=decodeRawMg(dv)
      const now=performance.now()

      // absolute before tare
      const abs = raw * scale

      // use zeroRaw for tare
      const net = (raw - zeroRaw) * scale

      if(smoothRef.current.skipUntil && now < smoothRef.current.skipUntil){
        return
      }

      const t=(now - startTimeRef.current)/1000
      const last=lastSampleRef.current
      if(last){
        const dt=Math.max(1e-6, t-last.t)
        const diff=Math.abs(net - last.g)
        const flowInstant=diff/dt
        const spikeDelta=8
        const spikeFlow=35
        if(diff>spikeDelta && flowInstant>spikeFlow){
          smoothRef.current.skipUntil=now+600
          return
        }
      }

      smoothRef.current.skipUntil=0

      smoothRef.current.net.push({t:now,value:net})
      smoothRef.current.abs.push({t:now,value:abs})
      const cutoff=now - smoothRef.current.durationMs
      while(smoothRef.current.net.length && smoothRef.current.net[0].t<cutoff){ smoothRef.current.net.shift() }
      while(smoothRef.current.abs.length && smoothRef.current.abs[0].t<cutoff){ smoothRef.current.abs.shift() }
      const avg=(arr)=>arr.reduce((acc,item)=>acc+item.value,0)/(arr.length||1)
      const smoothedNet=avg(smoothRef.current.net)
      const smoothedAbs=avg(smoothRef.current.abs)

      setAbsG(smoothedAbs)
      setNetG(smoothedNet)

      if(!tareApplied){
        setTareApplied(true)
        setTareValueG(smoothedAbs)  // what we substract logically as tare (abs at start)
        setTareTime(new Date().toISOString())
      }

      const lastAccepted=lastSampleRef.current; let flow=0
      if(lastAccepted){
        const dt=Math.max(1e-6, t-lastAccepted.t)
        flow=(smoothedNet-lastAccepted.g)/dt
      }

      const roundedFlow=Number(flow.toFixed(3))
      setFlowGps(roundedFlow)

      const newSample={t, g: smoothedNet, flow: roundedFlow}
      lastSampleRef.current=newSample
      setSamples(prev=>{
        const next=[...prev, newSample]
        return next.length>1800 ? next.slice(next.length-1800) : next
      })

      const exState=extractionRef.current
      if(!exState.hasBaseline){
        exState.baseline=smoothedNet
        exState.hasBaseline=true
      }
      if(!exState.active){
        if(smoothedNet<exState.baseline){ exState.baseline=smoothedNet }
        if(smoothedNet - exState.baseline >= 1){
          exState.active=true
          exState.start=now
          exState.lastRiseTime=now
          exState.lastRiseWeight=smoothedNet
          setExtractionInfo(prev=>({active:true,duration:0,lastDuration:prev.lastDuration}))
        }
      }else{
        if(smoothedNet - exState.lastRiseWeight >= 1){
          exState.lastRiseWeight=smoothedNet
          exState.lastRiseTime=now
        }
        const elapsedExtraction=(now - exState.start)/1000
        setExtractionInfo(prev=>{
          const nextDuration=Number(elapsedExtraction.toFixed(2))
          if(!prev.active || Math.abs(nextDuration-prev.duration)>0.009){
            return {active:true,duration:nextDuration,lastDuration:prev.lastDuration}
          }
          return prev
        })
        if(now - exState.lastRiseTime > 3000){
          const finalDuration=(now - exState.start)/1000
          exState.active=false
          exState.baseline=smoothedNet
          exState.lastRiseWeight=smoothedNet
          exState.lastRiseTime=now
          exState.hasBaseline=true
          setExtractionInfo({active:false,duration:0,lastDuration:Number(finalDuration.toFixed(2))})
        }
      }
    }

    notifyHandlerRef.current=onNotify
    await charRef.current.startNotifications()
    charRef.current.addEventListener('characteristicvaluechanged', onNotify)
  }

  function stop(){
    if(charRef.current && notifyHandlerRef.current){
      try{ charRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current) }catch{}
      charRef.current.stopNotifications().catch(()=>{})
      notifyHandlerRef.current=null
    }
    setRunning(false)
    setElapsed(0)
    setFlowGps(0)
    extractionRef.current={ baseline:netG, hasBaseline:true, active:false, start:0, lastRiseTime:0, lastRiseWeight:netG }
    setExtractionInfo(prev=>prev.active?{active:false,duration:0,lastDuration:prev.lastDuration}:prev)
    smoothRef.current={ net:[], abs:[], durationMs:300, skipUntil:0 }
  }

  async function disconnect(){ stop(); try{ deviceRef.current?.gatt?.disconnect() }catch{}; setConnected(false) }

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

  const chartData=useMemo(()=>({
    labels:samples.map(s=>s.t.toFixed(2)),
    datasets:[
      {
        label:'Peso neto (g)',
        yAxisID:'y',
        data:samples.map(s=>Number(s.g.toFixed(3))),
        fill:true,
        borderColor:'rgba(28,134,238,1)',
        backgroundColor:'rgba(28,134,238,0.15)',
        tension:0.2,
        pointRadius:0,
      },
      {
        label:'Flujo (g/s)',
        yAxisID:'y1',
        data:samples.map(s=>s.flow),
        fill:false,
        borderColor:'rgba(242,153,74,1)',
        backgroundColor:'rgba(242,153,74,0.25)',
        tension:0.25,
        pointRadius:0,
      }
    ]
  }),[samples])
  const chartOptions=useMemo(()=>({
    responsive:true,
    maintainAspectRatio:false,
    animation:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:true,labels:{usePointStyle:true}},
      tooltip:{
        callbacks:{
          label:(ctx)=>{
            const value=ctx.parsed.y
            return `${ctx.dataset.label}: ${value.toFixed(2)} ${ctx.dataset.yAxisID==='y'?'g':'g/s'}`
          }
        }
      }
    },
    scales:{
      x:{title:{display:true,text:'Tiempo (s)'},ticks:{maxTicksLimit:10}},
      y:{position:'left',title:{display:true,text:'Peso (g)'},grid:{color:'rgba(0,0,0,0.05)'}},
      y1:{position:'right',title:{display:true,text:'Flujo (g/s)'},grid:{drawOnChartArea:false},ticks:{callback:(value)=>value.toFixed?Number(value).toFixed(1):value}},
    }
  }),[])

  function downloadCSV(){
    const header='t_s,peso_neto_g,flujo_gps\n'
    const rows=samples.map(s=>`${s.t.toFixed(3)},${s.g.toFixed(3)},${s.flow.toFixed(3)}`).join('\n')
    const blob=new Blob([header+rows],{type:'text/csv'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='espresso_weight_timeseries.csv'; a.click(); URL.revokeObjectURL(url)
  }

  function downloadChartImage(){
    const chart=chartRef.current
    const chartInstance=chart && typeof chart.toBase64Image==='function' ? chart : chart?.chartInstance
    if(!chartInstance || typeof chartInstance.toBase64Image!=='function') return
    const url=chartInstance.toBase64Image('image/png',1)
    const a=document.createElement('a')
    a.href=url
    a.download='espresso_curve.png'
    a.click()
  }

  function formatTime(seconds, decimals=0){
    if(!isFinite(seconds)) return '0:00'
    const total=Math.max(0, seconds)
    const minutes=Math.floor(total/60)
    const secValue=total-minutes*60
    const width=decimals>0? 3+decimals : 2
    const secStr=(decimals>0? secValue.toFixed(decimals) : Math.floor(secValue).toString()).padStart(width,'0')
    return `${minutes}:${secStr}`
  }

  useEffect(()=>{
    if(!running) return
    let raf
    const tick=()=>{
      if(startTimeRef.current){
        const now=performance.now()
        const elapsedSec=Number(((now-startTimeRef.current)/1000).toFixed(2))
        setElapsed(prev=>Math.abs(prev-elapsedSec)>0.009?elapsedSec:prev)
        if(extractionRef.current.active){
          const exDuration=Number(((now-extractionRef.current.start)/1000).toFixed(2))
          setExtractionInfo(prev=>{
            if(!prev.active) return prev
            if(Math.abs(prev.duration-exDuration)<=0.009) return prev
            return {...prev,duration:exDuration}
          })
        }
      }
      raf=requestAnimationFrame(tick)
    }
    tick()
    return ()=>{ if(raf) cancelAnimationFrame(raf) }
  },[running])

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
      <div className="card" style={{padding:'16px'}}>
        <div className="sub">Timer total</div>
        <div className="metric-sm">{formatTime(elapsed)}</div>
        <div className="sub">Extraction time: <span className="kbd">{extractionInfo.active ? formatTime(extractionInfo.duration,1) : extractionInfo.lastDuration ? formatTime(extractionInfo.lastDuration,1) : '—'}</span> {extractionInfo.active ? <span className="ok">en curso</span> : extractionInfo.lastDuration ? <span className="ok">última</span> : <span className="warn">pendiente</span>}</div>
      </div>
    </div>

    <div className="section card">
      <div className="row" style={{alignItems:'flex-end'}}>
        <button onClick={resetCaptureState} disabled={!connected}>Reset curva</button>
        <button className="primary" onClick={()=>start()} disabled={!connected||running}>Iniciar</button>
        <button onClick={()=>stop()} disabled={!running}>Stop</button>
        <button onClick={zeroNow} disabled={!connected}>Zero ahora</button>
        <div className="row">
          <input id="refw" type="number" step="0.1" placeholder="Peso de referencia (g)" style={{width:220}} />
          <button onClick={()=>{ const el=document.getElementById('refw'); const v=parseFloat(el.value); if(!isFinite(v)||v<=0) return alert('Valor inválido.'); spanCal(v) }} disabled={!connected}>Calibrar span</button>
        </div>
        <button onClick={downloadCSV} disabled={samples.length===0}>Exportar CSV</button>
        <button onClick={downloadChartImage} disabled={samples.length===0}>Exportar gráfico</button>
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

    <div style={{marginTop:16, height:260}}><Line ref={chartRef} data={chartData} options={chartOptions}/></div>

    <div className="footer">HTTPS + Chrome/Edge. Android: habilita Ubicación y Dispositivos cercanos para Chrome.</div>
  </div></div>)
}
