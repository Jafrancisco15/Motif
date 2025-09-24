import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Chart, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale } from 'chart.js'
import logo from './logo.svg'

Chart.register(LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale)

const DEFAULT_SERVICE = '1bc50001-0200-0aa5-e311-24cb004a98c5'
const DEFAULT_CHAR = '1bc50002-0200-0aa5-e311-24cb004a98c5'

const FLOW_OPTIMAL_MIN = 1.5
const FLOW_OPTIMAL_MAX = 3.5
const PREINFUSION_THRESHOLD = 0.5

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function median(values){
  if(!values.length) return 0
  const sorted=[...values].sort((a,b)=>a-b)
  const mid=Math.floor(sorted.length/2)
  return sorted.length%2? sorted[mid] : (sorted[mid-1]+sorted[mid])/2
}

function mad(values, med){
  if(!values.length) return 0
  const diffs=values.map(v=>Math.abs(v-(med??median(values))))
  return median(diffs)
}

function correlation(xs, ys){
  const n=Math.min(xs.length, ys.length)
  if(n<2) return 0
  let sumX=0,sumY=0
  for(let i=0;i<n;i++){ sumX+=xs[i]; sumY+=ys[i] }
  const meanX=sumX/n, meanY=sumY/n
  let cov=0, varX=0, varY=0
  for(let i=0;i<n;i++){
    const dx=xs[i]-meanX
    const dy=ys[i]-meanY
    cov+=dx*dy
    varX+=dx*dx
    varY+=dy*dy
  }
  const denom=Math.sqrt(varX*varY)
  return denom? clamp(cov/denom, -1, 1) : 0
}

function decodeRawMg(dv){ return dv.getInt32(0,true) }

function useLocalStorage(key, initial){
  const [state, setState]=useState(()=>{
    try{
      const v=localStorage.getItem(key)
      return v!==null? JSON.parse(v) : initial
    }catch{ return initial }
  })
  useEffect(()=>{ try{ localStorage.setItem(key, JSON.stringify(state)) }catch{} },[key,state])
  return [state, setState]
}

export default function App(){
  const [connected,setConnected]=useState(false)
  const [connecting,setConnecting]=useState(false)
  const [deviceName,setDeviceName]=useState('')
  const [errorMsg,setErrorMsg]=useState('')

  const [profiles,setProfiles]=useLocalStorage('mentor.profiles', {})
  const [currentProfile,setCurrentProfile]=useLocalStorage('mentor.currentProfile', 'default')
  const [scale,setScale]=useLocalStorage(`mentor.${currentProfile}.scale`, 0.001)
  const [zeroRaw,setZeroRaw]=useLocalStorage(`mentor.${currentProfile}.zeroRaw`, 0)
  const [tareApplied,setTareApplied]=useState(false)
  const [tareValueG,setTareValueG]=useState(0)
  const [tareTime,setTareTime]=useState(null)

  const [absG,setAbsG]=useState(0)
  const [netG,setNetG]=useState(0)
  const [flowGps,setFlowGps]=useState(0)
  const [samples,setSamples]=useState([])
  const [running,setRunning]=useState(false)
  const [elapsed,setElapsed]=useState(0)
  const [extractionInfo,setExtractionInfo]=useState({active:false,duration:0,lastDuration:0})

  const scaleRef=useRef(scale)
  const zeroRawRef=useRef(zeroRaw)
  const charRef=useRef(null)
  const deviceRef=useRef(null)
  const notifyHandlerRef=useRef(null)
  const startTimeRef=useRef(null)
  const lastCapturedRef=useRef(null)
  const flowRef=useRef({time:null,net:0})
  const smoothRef=useRef({ net:[], abs:[], durationMs:300, skipUntil:0 })
  const extractionRef=useRef({ baseline:0, hasBaseline:false, active:false, start:0, lastRiseTime:0, lastRiseWeight:0 })
  const runningRef=useRef(false)
  const chartRef=useRef(null)

  useEffect(()=>{ runningRef.current=running },[running])

  useEffect(()=>{ scaleRef.current=scale },[scale])
  useEffect(()=>{ zeroRawRef.current=zeroRaw },[zeroRaw])

  useEffect(()=>{
    const storedScale=JSON.parse(localStorage.getItem(`mentor.${currentProfile}.scale`)||'0.001')
    const storedZero=JSON.parse(localStorage.getItem(`mentor.${currentProfile}.zeroRaw`)||'0')
    setScale(storedScale||0.001)
    setZeroRaw(storedZero||0)
    setTareApplied(false)
    setTareValueG(0)
    setTareTime(null)
  },[currentProfile])

  const analysis=useMemo(()=>{
    if(samples.length<3){
      return {
        preinfusionDuration:0,
        avgFlow:0,
        peakFlow:0,
        hydraulicScore:0,
        hydraulicSummary:'Sin datos suficientes para analizar la relación resistencia-flujo.',
        flowCorrelation:0,
        channelingIndex:0,
        channelingSpikes:0,
        channelingSummary:'',
        maxAccel:0,
        flowDistribution:{optimal:0,low:0,high:0},
        flowDistributionSummary:'',
        rampTime:0,
        finalFlow:0,
        minFlow:0,
        rampSlope:0
      }
    }

    const flows=samples.map(s=>s.flow)
    const weights=samples.map(s=>s.g)
    const times=samples.map(s=>s.t)

    const firstTime=times[0]
    const totalDuration=times[times.length-1]-firstTime

    let preIndex=0
    for(let i=0;i<flows.length;i++){
      if(flows[i]>PREINFUSION_THRESHOLD){
        const window=samples.slice(i, Math.min(i+5, samples.length))
        const avgWindow=window.reduce((acc,cur)=>acc+cur.flow,0)/window.length
        if(avgWindow>PREINFUSION_THRESHOLD){ preIndex=i; break }
      }
    }

    const preinfusionDuration=times[Math.max(preIndex,0)]-firstTime
    const activeSamples=samples.slice(preIndex)
    if(activeSamples.length<2){
      return {
        preinfusionDuration:Math.max(0, preinfusionDuration),
        avgFlow:0,
        peakFlow:0,
        hydraulicScore:0,
        hydraulicSummary:'Sin datos suficientes después de la preinfusión.',
        flowCorrelation:0,
        channelingIndex:0,
        channelingSpikes:0,
        channelingSummary:'',
        maxAccel:0,
        flowDistribution:{optimal:0,low:0,high:0},
        flowDistributionSummary:'',
        rampTime:0,
        finalFlow:0,
        minFlow:0,
        rampSlope:0
      }
    }

    const activeFlows=activeSamples.map(s=>s.flow)
    const activeWeights=activeSamples.map(s=>s.g)
    const activeTimes=activeSamples.map(s=>s.t)
    const activeDuration=activeTimes[activeTimes.length-1]-activeTimes[0]

    const avgFlow=activeFlows.reduce((acc,v)=>acc+v,0)/activeFlows.length
    const peakFlow=Math.max(...activeFlows.map(v=>isFinite(v)?v:0))
    const minFlow=Math.min(...activeFlows.map(v=>isFinite(v)?v:0))

    const rampWindowEnd=activeTimes[0]+Math.min(4, Math.max(1, activeDuration))
    const rampSlice=activeSamples.filter(s=>s.t<=rampWindowEnd)
    const rampSlope=rampSlice.length>1 ? (rampSlice[rampSlice.length-1].flow - rampSlice[0].flow)/Math.max(0.25, rampSlice[rampSlice.length-1].t-rampSlice[0].t) : 0

    const finalWindowStart=activeTimes[activeTimes.length-1]-Math.min(1.5, Math.max(0.5, activeDuration/3))
    const finalSlice=activeSamples.filter(s=>s.t>=finalWindowStart)
    const finalFlow=finalSlice.length? finalSlice.reduce((acc,s)=>acc+s.flow,0)/finalSlice.length : activeFlows[activeFlows.length-1]

    const hydraulicRatio=peakFlow? avgFlow/peakFlow : 0
    const hydraulicScore=Math.round(clamp((1-hydraulicRatio)*100,0,100))
    const correlationFlowWeight=correlation(activeWeights, activeFlows)

    let hydraulicSummary
    if(hydraulicScore>70){ hydraulicSummary='Resistencia muy alta: el flujo promedio es muy inferior al pico medido.' }
    else if(hydraulicScore>45){ hydraulicSummary='Resistencia elevada: el flujo tarda en abrirse, revisa molienda y distribución.' }
    else if(hydraulicScore>25){ hydraulicSummary='Resistencia moderada: la rampa de flujo es suave y consistente.' }
    else { hydraulicSummary='Resistencia baja: el flujo es ágil; vigila que no se sobre-extraiga.' }
    hydraulicSummary+=` Correlación flujo-peso: ${correlationFlowWeight.toFixed(2)}.`

    const flowMedian=median(activeFlows)
    const flowMad=mad(activeFlows, flowMedian)
    let spikeCount=0
    let maxAccel=0
    for(let i=1;i<activeSamples.length;i++){
      const dt=Math.max(0.05, activeSamples[i].t-activeSamples[i-1].t)
      const accel=(activeSamples[i].flow-activeSamples[i-1].flow)/dt
      if(Math.abs(accel)>maxAccel) maxAccel=Math.abs(accel)
      const spikeThreshold=flowMedian + 3*(flowMad||0.12)
      if(activeSamples[i].flow>spikeThreshold && accel>1){ spikeCount++ }
    }
    const channelingIndex=Math.round(clamp((spikeCount/Math.max(1, activeSamples.length-1))*250,0,100))
    let channelingSummary
    if(channelingIndex>65){ channelingSummary='Canalización crítica: múltiples picos repentinos de flujo.' }
    else if(channelingIndex>40){ channelingSummary='Canalización moderada: detectadas aceleraciones puntuales.' }
    else if(channelingIndex>15){ channelingSummary='Canalización leve: el flujo presenta pequeñas irregularidades.' }
    else { channelingSummary='Canalización mínima: la curva es uniforme.' }

    let timeOptimal=0, timeLow=0, timeHigh=0
    for(let i=1;i<activeSamples.length;i++){
      const dt=Math.max(0, activeSamples[i].t-activeSamples[i-1].t)
      const flow=activeSamples[i].flow
      if(flow<FLOW_OPTIMAL_MIN){ timeLow+=dt }
      else if(flow>FLOW_OPTIMAL_MAX){ timeHigh+=dt }
      else { timeOptimal+=dt }
    }
    const timeTotal=timeOptimal+timeLow+timeHigh || activeDuration || totalDuration || 1
    const flowDistribution={
      optimal: clamp((timeOptimal/timeTotal)*100,0,100),
      low: clamp((timeLow/timeTotal)*100,0,100),
      high: clamp((timeHigh/timeTotal)*100,0,100)
    }

    let flowDistributionSummary
    if(flowDistribution.optimal>60){ flowDistributionSummary='Mayor parte de la extracción dentro del rango clásico de espresso.' }
    else if(flowDistribution.high>flowDistribution.low){ flowDistributionSummary='Flujo alto predominante: probable sub-extracción o canalización.' }
    else if(flowDistribution.low>flowDistribution.high){ flowDistributionSummary='Flujo bajo predominante: posible sobre-extracción por alta resistencia.' }
    else { flowDistributionSummary='Distribución equilibrada pero con variaciones que conviene revisar.' }

    const targetPeak=peakFlow||finalFlow||avgFlow
    let rampTime=0
    if(targetPeak>0){
      for(let i=0;i<activeSamples.length;i++){
        if(activeSamples[i].flow>=0.9*targetPeak){ rampTime=activeSamples[i].t-activeTimes[0]; break }
      }
    }

    return {
      preinfusionDuration:Math.max(0, preinfusionDuration),
      avgFlow:isFinite(avgFlow)?avgFlow:0,
      peakFlow:isFinite(peakFlow)?peakFlow:0,
      hydraulicScore,
      hydraulicSummary,
      flowCorrelation:correlationFlowWeight,
      channelingIndex,
      channelingSpikes:spikeCount,
      channelingSummary,
      maxAccel:isFinite(maxAccel)?maxAccel:0,
      flowDistribution,
      flowDistributionSummary,
      rampTime:Math.max(0,rampTime),
      finalFlow:isFinite(finalFlow)?finalFlow:0,
      minFlow:isFinite(minFlow)?minFlow:0,
      rampSlope:isFinite(rampSlope)?rampSlope:0
    }
  },[samples])

  useEffect(()=>{ return ()=>{ cleanupNotifications(); try{ deviceRef.current?.gatt?.disconnect() }catch{} } },[])

  function cleanupNotifications(){
    if(charRef.current && notifyHandlerRef.current){
      try{ charRef.current.removeEventListener('characteristicvaluechanged', notifyHandlerRef.current) }catch{}
      try{ charRef.current.stopNotifications() }catch{}
      notifyHandlerRef.current=null
    }
  }

  function resetRunState(){
    const now=performance.now()
    startTimeRef.current=now
    lastCapturedRef.current=null
    setSamples([])
    setFlowGps(0)
    setElapsed(0)
    extractionRef.current={ baseline:netG, hasBaseline:true, active:false, start:0, lastRiseTime:0, lastRiseWeight:netG }
    setExtractionInfo(prev=>({active:false,duration:0,lastDuration:prev.lastDuration}))
  }

  async function connect(){
    try{
      setErrorMsg('')
      setConnecting(true)
      const device=await navigator.bluetooth.requestDevice({ acceptAllDevices:true, optionalServices:[DEFAULT_SERVICE] })
      deviceRef.current=device
      device.addEventListener('gattserverdisconnected', onDisconnect)
      const server=await device.gatt.connect()
      const service=await server.getPrimaryService(DEFAULT_SERVICE)
      const characteristic=await service.getCharacteristic(DEFAULT_CHAR)
      charRef.current=characteristic
      setDeviceName(device.name||'')
      setConnected(true)
      await ensureNotifications()
    }catch(err){
      onDisconnect()
      setErrorMsg(err?.message||String(err))
      try{ deviceRef.current?.gatt?.disconnect() }catch{}
    }finally{
      setConnecting(false)
    }
  }

  function onDisconnect(){
    cleanupNotifications()
    setConnected(false)
    setConnecting(false)
    setDeviceName('')
    setSamples([])
    setFlowGps(0)
    setElapsed(0)
    setRunning(false)
    runningRef.current=false
    setTareApplied(false)
    setTareValueG(0)
    setTareTime(null)
    extractionRef.current={ baseline:0, hasBaseline:false, active:false, start:0, lastRiseTime:0, lastRiseWeight:0 }
    setExtractionInfo({active:false,duration:0,lastDuration:0})
  }

  async function ensureNotifications(){
    if(!charRef.current || notifyHandlerRef.current) return

    const onNotify=(event)=>{
      const dv=new DataView(event.target.value.buffer)
      const raw=decodeRawMg(dv)
      const now=performance.now()

      const scaleValue=scaleRef.current || scale
      const zeroValue=zeroRawRef.current || zeroRaw
      const abs=raw*scaleValue
      const net=(raw-zeroValue)*scaleValue

      if(smoothRef.current.skipUntil && now < smoothRef.current.skipUntil){
        return
      }

      smoothRef.current.net.push({t:now,value:net})
      smoothRef.current.abs.push({t:now,value:abs})
      const cutoff=now - smoothRef.current.durationMs
      while(smoothRef.current.net.length && smoothRef.current.net[0].t<cutoff){ smoothRef.current.net.shift() }
      while(smoothRef.current.abs.length && smoothRef.current.abs[0].t<cutoff){ smoothRef.current.abs.shift() }
      const avg=(arr)=>arr.reduce((acc,item)=>acc+item.value,0)/(arr.length||1)
      const smoothedNet=avg(smoothRef.current.net)
      const smoothedAbs=avg(smoothRef.current.abs)

      const prevFlow=flowRef.current
      let instantaneousFlow=0
      if(prevFlow.time!==null){
        const dt=Math.max(1e-3, (now-prevFlow.time)/1000)
        const diff=smoothedNet-prevFlow.net
        const inst=diff/dt
        if(Math.abs(diff)>8 && Math.abs(inst)>35){
          smoothRef.current.skipUntil=now+600
          return
        }
        instantaneousFlow=inst
      }
      smoothRef.current.skipUntil=0

      setAbsG(smoothedAbs)
      setNetG(smoothedNet)
      flowRef.current={time:now,net:smoothedNet}
      setFlowGps(Number(instantaneousFlow.toFixed(3)))

      if(runningRef.current && startTimeRef.current){
        const t=(now-startTimeRef.current)/1000
        const lastCaptured=lastCapturedRef.current
        let flow=instantaneousFlow
        if(lastCaptured){
          const dt=Math.max(1e-3, t-lastCaptured.t)
          flow=(smoothedNet-lastCaptured.g)/dt
        }
        const roundedFlow=Number(flow.toFixed(3))
        const newSample={t, g: smoothedNet, flow: roundedFlow}
        lastCapturedRef.current=newSample
        setSamples(prev=>{
          const next=[...prev, newSample]
          return next.length>1800? next.slice(next.length-1800) : next
        })

        const exState=extractionRef.current
        if(!exState.hasBaseline){
          exState.baseline=smoothedNet
          exState.hasBaseline=true
          exState.lastRiseWeight=smoothedNet
          exState.lastRiseTime=now
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
          const elapsedExtraction=(now-exState.start)/1000
          const nextDuration=Number(elapsedExtraction.toFixed(2))
          setExtractionInfo(prev=>{
            if(!prev.active){ return {active:true,duration:nextDuration,lastDuration:prev.lastDuration} }
            if(Math.abs(prev.duration-nextDuration)<=0.009){ return prev }
            return {...prev,duration:nextDuration}
          })
          if(now - exState.lastRiseTime > 3000){
            const finalDuration=Number(((now-exState.start)/1000).toFixed(2))
            exState.active=false
            exState.baseline=smoothedNet
            exState.lastRiseWeight=smoothedNet
            exState.lastRiseTime=now
            setExtractionInfo({active:false,duration:0,lastDuration:finalDuration})
          }
        }
      }
    }

    notifyHandlerRef.current=onNotify
    await charRef.current.startNotifications()
    charRef.current.addEventListener('characteristicvaluechanged', onNotify)
  }

  function start(){
    if(!charRef.current) return
    resetRunState()
    setRunning(true)
  }

  function stop(){
    if(!runningRef.current){
      setRunning(false)
      return
    }
    const now=performance.now()
    if(extractionRef.current.active){
      const finalDuration=Number(((now-extractionRef.current.start)/1000).toFixed(2))
      setExtractionInfo({active:false,duration:0,lastDuration:finalDuration})
    }else{
      setExtractionInfo(prev=>({active:false,duration:0,lastDuration:prev.lastDuration}))
    }
    extractionRef.current={ baseline:netG, hasBaseline:true, active:false, start:0, lastRiseTime:0, lastRiseWeight:netG }
    setRunning(false)
    runningRef.current=false
    setElapsed(0)
    setFlowGps(0)
    startTimeRef.current=null
    lastCapturedRef.current=null
  }

  async function disconnect(){
    stop()
    cleanupNotifications()
    try{ deviceRef.current?.gatt?.disconnect() }catch{}
    onDisconnect()
  }

  function applyTare(){
    const scaleValue=scaleRef.current || scale
    const rawEst=scaleValue ? Math.round(absG/scaleValue) : 0
    setZeroRaw(rawEst)
    zeroRawRef.current=rawEst
    setTareApplied(true)
    setTareValueG(absG)
    setTareTime(new Date().toISOString())
    smoothRef.current.net=[]
    smoothRef.current.abs=[]
    setNetG(0)
    setFlowGps(0)
    extractionRef.current={ baseline:0, hasBaseline:true, active:false, start:0, lastRiseTime:performance.now(), lastRiseWeight:0 }
    flowRef.current={time:null,net:0}
  }

  function spanCal(knownG){
    const scaleValue=scaleRef.current || scale
    const zeroValue=zeroRawRef.current || zeroRaw
    const rawEst=scaleValue ? Math.round(absG/scaleValue) : 0
    const delta=rawEst - zeroValue
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
    const rec=profiles[name]
    if(rec){
      setScale(rec.scale)
      setZeroRaw(rec.zeroRaw)
      setCurrentProfile(name)
    }
  }

  function deleteProfile(name){
    if(!name || name==='default') return
    const updated={...profiles}
    delete updated[name]
    setProfiles(updated)
    localStorage.removeItem(`mentor.${name}.scale`)
    localStorage.removeItem(`mentor.${name}.zeroRaw`)
    if(currentProfile===name){ setCurrentProfile('default') }
  }

  function resetCurve(){
    resetRunState()
    setRunning(false)
    runningRef.current=false
  }

  const chartData=useMemo(()=>{
    const labels=samples.map(s=>s.t.toFixed(2))
    const safeMinLine=samples.map(()=>FLOW_OPTIMAL_MIN)
    const safeMaxLine=samples.map(()=>FLOW_OPTIMAL_MAX)
    const preinfusionLine=samples.map(()=>PREINFUSION_THRESHOLD)
    return {
      labels,
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
        },
        {
          label:`Límite seguro mínimo (${FLOW_OPTIMAL_MIN} g/s)`,
          yAxisID:'y1',
          data:safeMinLine,
          borderColor:'rgba(110,231,183,0.9)',
          borderDash:[6,6],
          pointRadius:0,
          fill:false,
        },
        {
          label:`Límite seguro máximo (${FLOW_OPTIMAL_MAX} g/s)`,
          yAxisID:'y1',
          data:safeMaxLine,
          borderColor:'rgba(248,113,113,0.9)',
          borderDash:[6,6],
          pointRadius:0,
          fill:false,
        },
        {
          label:`Preinfusión (${PREINFUSION_THRESHOLD} g/s)`,
          yAxisID:'y1',
          data:preinfusionLine,
          borderColor:'rgba(129,140,248,0.9)',
          borderDash:[4,4],
          pointRadius:0,
          fill:false,
        }
      ]
    }
  },[samples])

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
      y:{position:'left',title:{display:true,text:'Peso (g)'},grid:{color:'rgba(15,23,42,0.25)'}},
      y1:{position:'right',title:{display:true,text:'Flujo (g/s)'},grid:{drawOnChartArea:false},ticks:{callback:(value)=>value.toFixed?Number(value).toFixed(1):value}},
    }
  }),[])

  function downloadCSV(){
    const header='t_s,peso_neto_g,flujo_gps\n'
    const rows=samples.map(s=>`${s.t.toFixed(3)},${s.g.toFixed(3)},${s.flow.toFixed(3)}`).join('\n')
    const blob=new Blob([header+rows],{type:'text/csv'})
    const url=URL.createObjectURL(blob)
    const a=document.createElement('a')
    a.href=url
    a.download='espresso_weight_timeseries.csv'
    a.click()
    URL.revokeObjectURL(url)
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

  function downloadResults(){
    const payload={
      generatedAt:new Date().toISOString(),
      samples:samples.length,
      metrics:{
        preinfusionDuration:analysis.preinfusionDuration,
        avgFlow:analysis.avgFlow,
        peakFlow:analysis.peakFlow,
        finalFlow:analysis.finalFlow,
        hydraulicScore:analysis.hydraulicScore,
        flowCorrelation:analysis.flowCorrelation,
        channelingIndex:analysis.channelingIndex,
        channelingSpikes:analysis.channelingSpikes,
        maxAccel:analysis.maxAccel,
        flowDistribution:analysis.flowDistribution,
        rampTime:analysis.rampTime,
        rampSlope:analysis.rampSlope,
        minFlow:analysis.minFlow,
        safeFlowRange:[FLOW_OPTIMAL_MIN,FLOW_OPTIMAL_MAX],
        preinfusionThreshold:PREINFUSION_THRESHOLD
      },
      narratives:{
        hydraulic:analysis.hydraulicSummary,
        channeling:analysis.channelingSummary,
        distribution:analysis.flowDistributionSummary
      }
    }
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob)
    const a=document.createElement('a')
    a.href=url
    a.download='espresso_results.json'
    a.click()
    URL.revokeObjectURL(url)
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

  useEffect(()=>{
    if(!running){
      setElapsed(0)
    }
  },[running])

  return (
    <div className="container">
      <div className="card">
        <div className="row" style={{justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div className="row" style={{alignItems:'center',gap:12}}>
            <img src={logo} alt="Smart Espresso Tracker" className="logo" />
            <div>
              <h1 style={{margin:'0 0 4px',fontSize:'1.8rem'}}>Smart Espresso Tracker</h1>
              <div className="sub">Mentor Coffee Scale • Web Bluetooth</div>
            </div>
          </div>
          <span className="pill">{connected?`Conectado${deviceName?` a ${deviceName}`:''}`:'Desconectado'}</span>
        </div>

        <div className="row" style={{marginBottom:16}}>
          <button className="primary" disabled={connecting||connected} onClick={connect}>{connecting?'Escaneando…':'Conectar'}</button>
          <button onClick={disconnect} disabled={!connected}>Desconectar</button>
          <button onClick={resetCurve} disabled={!connected}>Reset curva</button>
          <button className="primary" onClick={start} disabled={!connected||running}>Iniciar</button>
          <button onClick={stop} disabled={!connected}>Stop</button>
        </div>

        {errorMsg && <div className="error" style={{marginBottom:16}}>Error: {errorMsg}</div>}

        <div className="grid" style={{marginBottom:16}}>
          <div className="card" style={{padding:'16px'}}>
            <div className="sub">Peso neto (con TARE)</div>
            <div className="metric">{netG.toFixed(2)} <span className="sub">g</span></div>
            <div className="sub">Velocidad de flujo: {flowGps.toFixed(2)} g/s</div>
          </div>
          <div className="card" style={{padding:'16px'}}>
            <div className="sub">Peso absoluto</div>
            <div className="metric-sm">{absG.toFixed(2)} <span className="sub">g</span></div>
            <div className="sub">TARE aplicado: {tareApplied ? <span className="ok">sí</span> : <span className="warn">no</span>}</div>
            <div className="sub">Valor TARE: <span className="kbd">{tareValueG.toFixed(2)} g</span> {tareTime && <span className="small">({new Date(tareTime).toLocaleTimeString()})</span>}</div>
          </div>
          <div className="card" style={{padding:'16px'}}>
            <div className="sub">Timer total</div>
            <div className="metric-sm">{formatTime(elapsed)}</div>
            <div className="sub">Extraction time: <span className="kbd">{extractionInfo.active ? formatTime(extractionInfo.duration,1) : extractionInfo.lastDuration ? formatTime(extractionInfo.lastDuration,1) : '—'}</span> {extractionInfo.active ? <span className="ok">en curso</span> : extractionInfo.lastDuration ? <span className="ok">última</span> : <span className="warn">pendiente</span>}</div>
          </div>
        </div>

        <div className="section card" style={{marginBottom:16}}>
          <div className="row" style={{justifyContent:'space-between',alignItems:'center'}}>
            <h3 style={{margin:'0'}}>Panel de resultados</h3>
            <button onClick={downloadResults} disabled={samples.length===0}>Exportar panel</button>
          </div>
          <div className="grid" style={{marginTop:12}}>
            <div className="card" style={{padding:'16px'}}>
              <div className="sub">Relación resistencia-flujo</div>
              <div className="metric-sm">{analysis.hydraulicScore.toFixed(0)} <span className="sub">índice</span></div>
              <div className="small">Promedio: {analysis.avgFlow.toFixed(2)} g/s • Pico: {analysis.peakFlow.toFixed(2)} g/s • Final: {analysis.finalFlow.toFixed(2)} g/s</div>
              <div className="small">Rampa inicial: {analysis.rampSlope.toFixed(2)} g/s² • Tiempo a 90% pico: {analysis.rampTime>0?`${analysis.rampTime.toFixed(1)} s`:'—'}</div>
              <div className="small">{analysis.hydraulicSummary}</div>
            </div>
            <div className="card" style={{padding:'16px'}}>
              <div className="sub">Índice de canalización</div>
              <div className="metric-sm">{analysis.channelingIndex.toFixed(0)} <span className="sub">/100</span></div>
              <div className="small">Picos detectados: {analysis.channelingSpikes} • Máx aceleración: {analysis.maxAccel.toFixed(2)} g/s²</div>
              <div className="small">{analysis.channelingSummary}</div>
            </div>
            <div className="card" style={{padding:'16px'}}>
              <div className="sub">Distribución del flujo</div>
              <div className="small">Preinfusión: {analysis.preinfusionDuration>0?`${analysis.preinfusionDuration.toFixed(1)} s`:'—'} • Flujo mínimo: {analysis.minFlow.toFixed(2)} g/s</div>
              <div className="small">En rango ({FLOW_OPTIMAL_MIN}-{FLOW_OPTIMAL_MAX} g/s): {analysis.flowDistribution.optimal.toFixed(0)}%</div>
              <div className="small">Bajo rango: {analysis.flowDistribution.low.toFixed(0)}% • Alto rango: {analysis.flowDistribution.high.toFixed(0)}%</div>
              <div className="small">{analysis.flowDistributionSummary}</div>
            </div>
          </div>
        </div>

        <div className="section card" style={{marginBottom:16}}>
          <div className="row" style={{flexWrap:'wrap',gap:12}}>
            <button onClick={applyTare} disabled={!connected}>(TARE)</button>
            <div className="row" style={{alignItems:'center',gap:8}}>
              <input id="refw" type="number" step="0.1" placeholder="Peso de referencia (g)" style={{width:220}} />
              <button onClick={()=>{ const el=document.getElementById('refw'); const v=parseFloat(el.value); if(!isFinite(v)||v<=0) return alert('Valor inválido.'); spanCal(v) }} disabled={!connected}>Calibrar span</button>
            </div>
            <button onClick={downloadCSV} disabled={samples.length===0}>Exportar CSV</button>
            <button onClick={downloadChartImage} disabled={samples.length===0}>Exportar gráfico</button>
          </div>
          <div className="small" style={{marginTop:8}}>Flujo: derivada del peso neto. Usa <b>(TARE)</b> con la taza vacía y calibra con un peso conocido para ajustar <i>scale</i>.</div>
        </div>

        <div className="section card" style={{marginBottom:16}}>
          <h3 style={{marginTop:0,marginBottom:4}}>Perfiles de TARE</h3>
          <div className="sub" style={{marginBottom:12}}>Guarda y recupera la calibración de cada taza o portafiltro.</div>
          <div className="row" style={{flexWrap:'wrap'}}>
            <select value={currentProfile} onChange={e=>loadProfile(e.target.value)}>
              <option value={currentProfile}>{currentProfile}</option>
              {Object.keys(profiles).filter(p=>p!==currentProfile).map(p=>(<option key={p} value={p}>{p}</option>))}
            </select>
            <input type="text" id="pname" placeholder="Nombre de perfil (ej. Taza A)" style={{width:240}} />
            <button onClick={()=>{ const n=document.getElementById('pname').value.trim(); saveProfile(n) }}>Guardar perfil</button>
            <button onClick={()=>{ const n=currentProfile; if(n==='default') return alert('No puedes borrar el perfil default'); if(confirm('¿Borrar perfil '+n+'?')) deleteProfile(n) }}>Borrar perfil actual</button>
          </div>
        </div>

        <div style={{marginTop:16, height:260}}><Line ref={chartRef} data={chartData} options={chartOptions}/></div>

        <div className="footer">Desarrollada por Jairon Francisco para Café Maguana/Escuela de Café</div>
      </div>
    </div>
  )
}

