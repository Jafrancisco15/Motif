import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Chart, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale } from 'chart.js'
import zoneSinpfCsv from '../values/flow_zone_sinpf.csv?raw'
import zoneConpfCsv from '../values/flow_zone_conpf.csv?raw'
import logo from './logo.svg'

Chart.register(LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend, Filler, CategoryScale)

const DEFAULT_SERVICE = '1bc50001-0200-0aa5-e311-24cb004a98c5'
const DEFAULT_CHAR = '1bc50002-0200-0aa5-e311-24cb004a98c5'

const FLOW_OPTIMAL_MIN = 1.5
const FLOW_OPTIMAL_MAX = 3.5
const PREINFUSION_THRESHOLD = 0.5

const FLOW_ZONE_SOURCES = {
  SINPF: {
    id: 'SINPF',
    label: 'Zona segura sin preinfusión',
    shortLabel: 'sin preinfusión',
    optionLabel: 'SIN preinfusión (SINPF)',
    description: 'Envelope recomendado para extracciones directas sin etapa de preinfusión prolongada.',
    csv: zoneSinpfCsv
  },
  CONPF: {
    id: 'CONPF',
    label: 'Zona segura con preinfusión',
    shortLabel: 'con preinfusión',
    optionLabel: 'CON preinfusión (CONPF)',
    description: 'Envelope recomendado cuando se aplica preinfusión antes del flujo principal.',
    csv: zoneConpfCsv
  }
}

const parseNumber = (value) => {
  if(value === undefined || value === null) return null
  const normalized = String(value).trim().replace(/\s+/g, '')
  if(!normalized){ return null }
  const parsed = Number.parseFloat(normalized.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const interpolateNodes = (nodes, progress) => {
  if(!nodes || !nodes.length){
    return null
  }
  if(!Number.isFinite(progress)){
    const first = nodes[0]
    return { min: first.min ?? 0, max: first.max ?? 0 }
  }
  const sorted = [...nodes].sort((a,b)=>a.progress-b.progress)
  const start = sorted[0]
  const end = sorted[sorted.length-1]
  const clampedProgress = clamp(progress, start.progress, end.progress)
  for(let i=0;i<sorted.length-1;i++){
    const current = sorted[i]
    const next = sorted[i+1]
    if(clampedProgress <= next.progress){
      const denom = Math.max(1e-6, next.progress - current.progress)
      const span = clamp((clampedProgress - current.progress) / denom, 0, 1)
      return {
        min: (current.min ?? 0) + ((next.min ?? 0) - (current.min ?? 0)) * span,
        max: (current.max ?? 0) + ((next.max ?? 0) - (current.max ?? 0)) * span
      }
    }
  }
  return { min: end.min ?? 0, max: end.max ?? 0 }
}

const parseZoneCsv = (rawCsv) => {
  if(!rawCsv){
    return { segments: [], envelope: [] }
  }
  const lines = String(rawCsv)
    .split(/\r?\n/)
    .map(line=>line.trim())
    .filter(line=>line && !line.startsWith('#'))
  if(!lines.length){
    return { segments: [], envelope: [] }
  }
  const header = lines[0].split(',').map(cell=>cell.trim().toLowerCase())
  const idxSegment = header.indexOf('segment')
  const idxLabel = header.indexOf('label')
  const idxProgress = header.indexOf('progress')
  const idxMin = header.indexOf('min')
  const idxMax = header.indexOf('max')
  const segmentsMap = new Map()

  for(let i=1;i<lines.length;i++){
    const cells = lines[i].split(',')
    const segmentId = idxSegment>=0 ? (cells[idxSegment]||'segment') : 'segment'
    const label = idxLabel>=0 ? (cells[idxLabel]||'') : ''
    const progress = idxProgress>=0 ? parseNumber(cells[idxProgress]) : null
    const min = idxMin>=0 ? parseNumber(cells[idxMin]) : null
    const max = idxMax>=0 ? parseNumber(cells[idxMax]) : null
    if(!Number.isFinite(progress) || !Number.isFinite(min) || !Number.isFinite(max)){
      continue
    }
    if(!segmentsMap.has(segmentId)){
      segmentsMap.set(segmentId, { id: segmentId, label: label || '', nodes: [] })
    }
    const segment = segmentsMap.get(segmentId)
    if(label && !segment.label){ segment.label = label }
    segment.nodes.push({ progress, min, max })
  }

  const segments = Array.from(segmentsMap.values()).map(segment=>({
    ...segment,
    nodes: segment.nodes.sort((a,b)=>a.progress-b.progress)
  })).filter(segment=>segment.nodes.length)

  const progressPoints = Array.from(new Set(segments.flatMap(segment=>segment.nodes.map(node=>node.progress))))
    .sort((a,b)=>a-b)

  const envelope = progressPoints.map(progress=>{
    const ranges = segments
      .map(segment=>{
        const range = interpolateNodes(segment.nodes, progress)
        return range ? { ...range, segmentId: segment.id, label: segment.label } : null
      })
      .filter(Boolean)
    if(!ranges.length){
      return { progress, min:0, max:0, ranges:[] }
    }
    return {
      progress,
      min: Math.min(...ranges.map(range=>range.min)),
      max: Math.max(...ranges.map(range=>range.max)),
      ranges
    }
  })

  return { segments, envelope }
}

const FLOW_ZONE_PRESETS = Object.fromEntries(
  Object.entries(FLOW_ZONE_SOURCES).map(([id, meta])=>{
    const parsed = parseZoneCsv(meta.csv)
    return [
      id,
      {
        ...meta,
        nodes: parsed.envelope.map(({ progress, min, max })=>({ progress, min, max })),
        envelope: parsed.envelope
      }
    ]
  })
)

const randomBetween = (min, max) => min + (max - min) * Math.random()

function generateSimulatedExtraction(mode='optimal'){
  const dt=0.25
  const totalSteps=Math.max(96, Math.round(randomBetween(24, 32)/dt))
  const totalDuration=Number((totalSteps*dt).toFixed(2))
  const preinfusionSteps=Math.min(totalSteps-12, Math.max(8, Math.round(randomBetween(3.5, 6.5)/dt)))
  const pattern=mode==='optimal' ? 'balanced' : (Math.random()>0.5 ? 'high' : 'low')

  const samples=[{t:0, g:0, flow:0}]
  let weight=0
  let extractionStart=null
  let extractionStop=null
  let lowFlowStart=null

  for(let step=1; step<=totalSteps; step++){
    const time=Number((step*dt).toFixed(3))
    let flow=0
    if(step<=preinfusionSteps){
      const progress=step/preinfusionSteps
      flow=randomBetween(0.02,0.12)*progress
    }else{
      const progress=Math.min(1, (step-preinfusionSteps)/Math.max(totalSteps-preinfusionSteps,1))
      if(mode==='optimal'){
        const startFlow=randomBetween(0.6,0.9)
        const peakFlow=randomBetween(1.6,2.05)
        const sustainFlow=randomBetween(1.4,1.75)
        const finishFlow=randomBetween(0.8,1.2)
        if(progress<0.3){
          const local=progress/0.3
          flow=startFlow + (peakFlow-startFlow)*local
        }else if(progress<0.75){
          const local=(progress-0.3)/0.45
          flow=peakFlow + (sustainFlow-peakFlow)*local
        }else{
          const local=(progress-0.75)/0.25
          flow=sustainFlow + (finishFlow-sustainFlow)*local
        }
        flow+=randomBetween(-0.12,0.12)
      }else if(pattern==='high'){
        const startFlow=randomBetween(1.2,1.8)
        const peakFlow=randomBetween(3.6,4.4)
        const finishFlow=randomBetween(2.6,3.4)
        if(progress<0.25){
          const local=progress/0.25
          flow=startFlow + (peakFlow-startFlow)*local
        }else{
          const local=(progress-0.25)/0.75
          flow=peakFlow + (finishFlow-peakFlow)*local
        }
        if(Math.random()<0.3){
          const spikeCenter=randomBetween(0.35,0.7)
          const width=0.08
          const spikeFactor=Math.max(0, 1-Math.abs(progress-spikeCenter)/width)
          flow+=spikeFactor*randomBetween(1.0,1.8)
        }
        flow+=randomBetween(-0.15,0.15)
      }else{
        const startFlow=randomBetween(0.25,0.5)
        const peakFlow=randomBetween(0.75,1.1)
        const finishFlow=randomBetween(0.25,0.55)
        if(progress<0.45){
          const local=progress/0.45
          flow=startFlow + (peakFlow-startFlow)*local
        }else{
          const local=(progress-0.45)/0.55
          flow=peakFlow + (finishFlow-peakFlow)*local
        }
        if(Math.random()<0.35){
          const dipCenter=randomBetween(0.55,0.85)
          const width=0.1
          const dipFactor=Math.max(0, 1-Math.abs(progress-dipCenter)/width)
          flow-=dipFactor*randomBetween(0.2,0.5)
        }
        flow+=randomBetween(-0.08,0.08)
      }
      flow=Math.max(0, flow)
    }

    weight+=flow*dt
    const roundedFlow=Number(flow.toFixed(3))
    const roundedWeight=Number(weight.toFixed(3))
    samples.push({ t: time, g: roundedWeight, flow: roundedFlow })

    if(roundedWeight>=1 && extractionStart===null){
      extractionStart=time
    }
    if(extractionStart!==null){
      if(flow<0.2){
        if(lowFlowStart===null){ lowFlowStart=time }
        if(extractionStop===null && time-lowFlowStart>=1){
          extractionStop=time
        }
      }else{
        lowFlowStart=null
        if(extractionStop!==null){ extractionStop=null }
      }
    }
  }

  const finalSample=samples[samples.length-1] || { t: totalDuration, g: Number(weight.toFixed(3)), flow:0 }
  if(extractionStart!==null && extractionStop===null){
    extractionStop=finalSample.t
  }
  const extractionDuration=extractionStart!==null ? Math.max(0, Number(((extractionStop - extractionStart)||0).toFixed(2))) : 0
  const label = mode==='optimal' ? 'en rango' : (pattern==='high' ? 'flujo alto' : 'flujo bajo')

  return {
    samples,
    totalDuration: finalSample.t,
    extractionDuration,
    finalWeight: finalSample.g,
    profileLabel: label
  }
}

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
  const [zonePreset,setZonePreset]=useLocalStorage('mentor.flowZonePreset', 'SINPF')
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
  const [simulatorStatus,setSimulatorStatus]=useState('')

  const activeZone=useMemo(()=>FLOW_ZONE_PRESETS[zonePreset] || FLOW_ZONE_PRESETS.SINPF,[zonePreset])

  const scaleRef=useRef(scale)
  const zeroRawRef=useRef(zeroRaw)
  const charRef=useRef(null)
  const deviceRef=useRef(null)
  const notifyHandlerRef=useRef(null)
  const startTimeRef=useRef(null)
  const lastCapturedRef=useRef(null)
  const flowRef=useRef({time:null,net:0})
  const smoothRef=useRef({ net:[], abs:[], durationMs:300, skipUntil:0 })
  const stabilityRef=useRef({
    net:[],
    abs:[],
    holdNet:null,
    holdAbs:null,
    durationMs:1800,
    releaseThreshold:0.15
  })
  const extractionRef=useRef({ baseline:0, hasBaseline:false, active:false, start:0, lastRiseTime:0, lastRiseWeight:0 })
  const runningRef=useRef(false)
  const chartRef=useRef(null)
  const importInputRef=useRef(null)

  useEffect(()=>{ runningRef.current=running },[running])

  useEffect(()=>{ scaleRef.current=scale },[scale])
  useEffect(()=>{ zeroRawRef.current=zeroRaw },[zeroRaw])

  function resetFilters(){
    smoothRef.current.net=[]
    smoothRef.current.abs=[]
    smoothRef.current.skipUntil=0
    const state=stabilityRef.current
    state.net=[]
    state.abs=[]
    state.holdNet=null
    state.holdAbs=null
  }

  function stabilizeValue(channel, value, now){
    const state=stabilityRef.current
    const buffer=channel==='net'?state.net:state.abs
    const holdKey=channel==='net'?'holdNet':'holdAbs'
    buffer.push({t:now,value})
    const cutoff=now-state.durationMs
    while(buffer.length && buffer[0].t<cutoff){ buffer.shift() }
    if(buffer.length){
      let min=buffer[0].value
      let max=buffer[0].value
      const values=buffer.map(item=>{
        if(item.value<min){ min=item.value }
        if(item.value>max){ max=item.value }
        return item.value
      })
      const med=median(values)
      const deviation=mad(values, med)
      const range=max-min
      if(values.length>=6 && deviation<=0.003 && range<=0.03 && Math.abs(value-med)<=0.05){
        state[holdKey]=med
      }else if(state[holdKey]!==null){
        if(Math.abs(value-state[holdKey])>state.releaseThreshold || range>0.08){
          state[holdKey]=null
        }
      }
      if(state[holdKey]!==null){
        return state[holdKey]
      }
    }
    return value
  }

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
    const zoneConfig=activeZone || FLOW_ZONE_PRESETS.SINPF
    const zoneNodes=zoneConfig?.nodes || []
    const zoneMeta={
      id: zoneConfig?.id || 'SINPF',
      label: zoneConfig?.label || 'Zona segura',
      short: zoneConfig?.shortLabel || 'sin preinfusión',
      description: zoneConfig?.description || ''
    }

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
        rampSlope:0,
        preinfusionIndex:0,
        extractionDuration:0,
        totalDuration:0,
        zoneGuide:[],
        zoneCoverage:{inside:0,below:0,above:0},
        zoneAverageGap:0,
        zoneMaxGap:0,
        zoneSummary:`Sin datos suficientes para comparar con la zona ${zoneMeta.short}.`,
        zonePresetId:zoneMeta.id,
        zoneLabel:zoneMeta.label,
        zoneShort:zoneMeta.short,
        zoneDescription:zoneMeta.description
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
        rampSlope:0,
        preinfusionIndex:preIndex,
        extractionDuration:0,
        totalDuration:Math.max(0,totalDuration),
        zoneGuide:[],
        zoneCoverage:{inside:0,below:0,above:0},
        zoneAverageGap:0,
        zoneMaxGap:0,
        zoneSummary:`Sin datos suficientes para comparar con la zona ${zoneMeta.short}.`,
        zonePresetId:zoneMeta.id,
        zoneLabel:zoneMeta.label,
        zoneShort:zoneMeta.short,
        zoneDescription:zoneMeta.description
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

    const zoneGuide=[]
    let zoneInside=0
    let zoneBelow=0
    let zoneAbove=0
    let zoneGapWeighted=0
    let zoneMaxGap=0
    for(let i=0;i<activeSamples.length;i++){
      const progress = activeDuration>0 ? (activeSamples[i].t-activeTimes[0]) / Math.max(activeDuration, 1e-6) : 0
      const envelopeRange = interpolateNodes(zoneNodes, progress) || { min:0, max:0 }
      zoneGuide.push({
        t: activeSamples[i].t,
        min: envelopeRange.min,
        max: envelopeRange.max
      })
      if(i===0) continue
      const dt=Math.max(0, activeSamples[i].t-activeSamples[i-1].t)
      const flow=activeSamples[i].flow
      let classification
      let gapValue=0
      if(flow>=envelopeRange.min && flow<=envelopeRange.max){
        classification='inside'
      }else if(flow<envelopeRange.min){
        classification='below'
        gapValue=envelopeRange.min-flow
      }else{
        classification='above'
        gapValue=flow-envelopeRange.max
      }
      if(classification==='inside'){
        zoneInside+=dt
      }else if(classification==='below'){
        zoneBelow+=dt
      }else if(classification==='above'){
        zoneAbove+=dt
      }
      if(classification!=='inside' && gapValue>0){
        zoneGapWeighted+=gapValue*dt
        if(gapValue>zoneMaxGap){ zoneMaxGap=gapValue }
      }
    }
    const zoneTotal=Math.max(zoneInside+zoneBelow+zoneAbove, activeDuration, 1e-6)
    const zoneCoverage={
      inside:clamp((zoneInside/zoneTotal)*100,0,100),
      below:clamp((zoneBelow/zoneTotal)*100,0,100),
      above:clamp((zoneAbove/zoneTotal)*100,0,100)
    }
    const zoneAverageGap=zoneGapWeighted/zoneTotal
    let zoneNarrative
    if(zoneCoverage.inside>65){
      zoneNarrative='Extracción alineada con la zona recomendada durante la mayor parte del tiro.'
    }else if(zoneCoverage.above>zoneCoverage.below){
      zoneNarrative='Predominan caudales por encima de la zona; riesgo de sub-extracción o canalización.'
    }else if(zoneCoverage.below>zoneCoverage.above){
      zoneNarrative='Predominan caudales por debajo de la zona; posible sobre-extracción por resistencia alta.'
    }else{
      zoneNarrative='Flujo alternando entre los límites recomendados; ajusta distribución y molienda.'
    }
    if(zoneMaxGap>0.35){
      zoneNarrative+=` Picos fuera de zona de hasta ${zoneMaxGap.toFixed(2)} g/s.`
    }
    const zoneSummary=`Zona ${zoneMeta.short}: ${zoneNarrative}`

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
      rampSlope:isFinite(rampSlope)?rampSlope:0,
      preinfusionIndex:preIndex,
      extractionDuration:Math.max(0, activeDuration),
      totalDuration:Math.max(0, totalDuration),
      zoneGuide,
      zoneCoverage,
      zoneAverageGap:isFinite(zoneAverageGap)?zoneAverageGap:0,
      zoneMaxGap:isFinite(zoneMaxGap)?zoneMaxGap:0,
      zoneSummary,
      zonePresetId:zoneMeta.id,
      zoneLabel:zoneMeta.label,
      zoneShort:zoneMeta.short,
      zoneDescription:zoneMeta.description
    }
  },[samples, activeZone])

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
    resetFilters()
    startTimeRef.current=now
    lastCapturedRef.current=null
    setSamples([])
    setFlowGps(0)
    setElapsed(0)
    extractionRef.current={ baseline:netG, hasBaseline:true, active:false, start:0, lastRiseTime:0, lastRiseWeight:netG }
    setExtractionInfo(prev=>({active:false,duration:0,lastDuration:prev.lastDuration}))
    setSimulatorStatus('')
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
    resetFilters()
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
      if(prevFlow.time!==null){
        const dt=Math.max(1e-3, (now-prevFlow.time)/1000)
        const diff=smoothedNet-prevFlow.net
        const inst=diff/dt
        if(Math.abs(diff)>8 && Math.abs(inst)>35){
          smoothRef.current.skipUntil=now+600
          return
        }
      }
      smoothRef.current.skipUntil=0

      const stableNet=stabilizeValue('net', smoothedNet, now)
      const stableAbs=stabilizeValue('abs', smoothedAbs, now)

      let instantaneousFlow=0
      if(prevFlow.time!==null){
        const dt=Math.max(1e-3, (now-prevFlow.time)/1000)
        instantaneousFlow=(stableNet-prevFlow.net)/dt
      }

      setAbsG(stableAbs)
      setNetG(stableNet)
      flowRef.current={time:now,net:stableNet}
      setFlowGps(Number(instantaneousFlow.toFixed(3)))

      if(runningRef.current && startTimeRef.current){
        const t=(now-startTimeRef.current)/1000
        const lastCaptured=lastCapturedRef.current
        let flow=instantaneousFlow
        if(lastCaptured){
          const dt=Math.max(1e-3, t-lastCaptured.t)
          flow=(stableNet-lastCaptured.g)/dt
        }
        const roundedFlow=Number(flow.toFixed(3))
        const newSample={t, g: stableNet, flow: roundedFlow}
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
    setSimulatorStatus('')
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
    resetFilters()
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
    setSimulatorStatus('')
  }

  const chartData=useMemo(()=>{
    const labels=samples.map(s=>s.t.toFixed(2))
    const preIndex=analysis.preinfusionIndex||0
    const zoneGuide=analysis.zoneGuide||[]
    const zoneLabel=analysis.zoneShort ? `Zona segura (${analysis.zoneShort})` : 'Zona segura'
    const zoneDatasets=[]
    if(zoneGuide.length){
      const zoneMaxLine=samples.map((_,idx)=>{
        if(idx<preIndex){ return null }
        const guide=zoneGuide[idx-preIndex]
        if(guide && isFinite(guide.max)){ return Number(guide.max.toFixed(3)) }
        const last=zoneGuide[zoneGuide.length-1]
        return last && isFinite(last.max)? Number(last.max.toFixed(3)) : null
      })
      const zoneMinLine=samples.map((_,idx)=>{
        if(idx<preIndex){ return null }
        const guide=zoneGuide[idx-preIndex]
        if(guide && isFinite(guide.min)){ return Number(guide.min.toFixed(3)) }
        const last=zoneGuide[zoneGuide.length-1]
        return last && isFinite(last.min)? Number(last.min.toFixed(3)) : null
      })
      zoneDatasets.push({
        label:zoneLabel,
        yAxisID:'y1',
        data:zoneMinLine,
        borderColor:'rgba(34,197,94,0)',
        backgroundColor:'rgba(34,197,94,0)',
        pointRadius:0,
        tension:0.25,
        fill:false,
        skipLegend:true
      })
      zoneDatasets.push({
        label:zoneLabel,
        yAxisID:'y1',
        data:zoneMaxLine,
        borderColor:'rgba(34,197,94,0)',
        backgroundColor:'rgba(34,197,94,0.22)',
        pointRadius:0,
        tension:0.25,
        borderWidth:0,
        fill:'-1'
      })
    }
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
        ...zoneDatasets
      ]
    }
  },[analysis, samples])

  const chartOptions=useMemo(()=>({
    responsive:true,
    maintainAspectRatio:false,
    animation:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{
        display:true,
        labels:{
          usePointStyle:true,
          filter:(legendItem, data)=>{
            const dataset=data?.datasets?.[legendItem.datasetIndex]
            return !dataset?.skipLegend
          }
        }
      },
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

  async function downloadPanelComposite(){
    if(!samples.length) return
    const chart=chartRef.current
    const chartInstance=chart && typeof chart.toBase64Image==='function' ? chart : chart?.chartInstance
    if(!chartInstance || typeof chartInstance.toBase64Image!=='function') return
    const chartCanvas=chartInstance.canvas || chartInstance.ctx?.canvas || null
    try{
      const chartUrl=chartInstance.toBase64Image('image/png',1)
      const chartImage=new Image()
      const loadImage=()=>new Promise((resolve,reject)=>{
        chartImage.onload=()=>resolve()
        chartImage.onerror=reject
      })
      chartImage.src=chartUrl
      await loadImage()

      const safeFixed=(value,digits=2)=>Number.isFinite(value)? value.toFixed(digits): (0).toFixed(digits)
      const cards=[
        {
          title:'Relación resistencia-flujo',
          metric:`${safeFixed(analysis.hydraulicScore,0)} índice`,
          details:[
            { text:`Promedio: ${safeFixed(analysis.avgFlow)} g/s • Pico: ${safeFixed(analysis.peakFlow)} g/s • Final: ${safeFixed(analysis.finalFlow)} g/s`, color:'#475569' },
            { text:`Rampa inicial: ${safeFixed(analysis.rampSlope)} g/s² • Tiempo a 90% pico: ${analysis.rampTime>0?`${analysis.rampTime.toFixed(1)} s`:'—'}`, color:'#475569' },
            { text:analysis.hydraulicSummary, color:'#0f172a' }
          ]
        },
        {
          title:'Índice de canalización',
          metric:`${safeFixed(analysis.channelingIndex,0)} /100`,
          details:[
            { text:`Picos detectados: ${analysis.channelingSpikes} • Máx aceleración: ${safeFixed(analysis.maxAccel)} g/s²`, color:'#475569' },
            { text:analysis.channelingSummary, color:'#0f172a' }
          ]
        },
        {
          title:'Distribución del flujo',
          metric:`Óptimo: ${safeFixed(analysis.flowDistribution.optimal,0)}%`,
          details:[
            { text:`Bajo: ${safeFixed(analysis.flowDistribution.low,0)}% • Alto: ${safeFixed(analysis.flowDistribution.high,0)}%`, color:'#475569' },
            { text:`Preinfusión: ${analysis.preinfusionDuration>0?`${analysis.preinfusionDuration.toFixed(1)} s`:'—'} • Flujo mínimo: ${safeFixed(analysis.minFlow)} g/s`, color:'#475569' },
            { text:`Rango clásico: ${FLOW_OPTIMAL_MIN}-${FLOW_OPTIMAL_MAX} g/s`, color:'#475569' },
            { text:analysis.flowDistributionSummary, color:'#0f172a' }
          ]
        },
        {
          title:`Zona segura (${analysis.zoneShort})`,
          metric:`En zona: ${safeFixed(analysis.zoneCoverage.inside,0)}%`,
          details:[
            { text:analysis.zoneLabel, color:'#475569' },
            analysis.zoneDescription ? { text:analysis.zoneDescription, color:'#64748b' } : null,
            { text:`Debajo: ${safeFixed(analysis.zoneCoverage.below,0)}% • Encima: ${safeFixed(analysis.zoneCoverage.above,0)}%`, color:'#475569' },
            { text:`Brecha media: ${safeFixed(analysis.zoneAverageGap)} g/s • Máx brecha: ${safeFixed(analysis.zoneMaxGap)} g/s`, color:'#475569' },
            { text:analysis.zoneSummary, color:'#0f172a' }
          ].filter(Boolean)
        }
      ]

      const width=1280
      const margin=56
      const headerHeight=130
      const gap=28
      const cardColumns=2
      const cardWidth=(width - margin*2 - gap*(cardColumns-1))/cardColumns
      const cardHeight=230
      const cardRows=Math.ceil(cards.length/cardColumns)
      const cardsAreaHeight=cardRows*cardHeight + (cardRows-1)*gap
      const panelHeight=headerHeight + cardsAreaHeight
      const chartTargetWidth=width - margin*2
      const baseChartWidth=chartCanvas?.width || chartImage.width || chartTargetWidth
      const baseChartHeight=chartCanvas?.height || chartImage.height || (chartTargetWidth*0.5)
      const chartScale=baseChartWidth? chartTargetWidth/Math.max(baseChartWidth,1) : 1
      const chartTargetHeight=Math.round(baseChartHeight * chartScale)
      const chartSpacing=48
      const totalHeight=Math.round(margin + panelHeight + chartSpacing + chartTargetHeight + margin)

      const canvas=document.createElement('canvas')
      canvas.width=width
      canvas.height=totalHeight
      const ctx=canvas.getContext('2d')
      if(!ctx) return
      ctx.fillStyle='#ffffff'
      ctx.fillRect(0,0,width,totalHeight)

      ctx.fillStyle='#0f172a'
      ctx.font='bold 34px Arial'
      ctx.fillText('Panel de resultados', margin, margin+40)
      ctx.font='20px Arial'
      ctx.fillStyle='#1e293b'
      ctx.fillText(analysis.zoneLabel||'', margin, margin+72)
      ctx.font='16px Arial'
      ctx.fillStyle='#64748b'
      ctx.fillText(`Generado: ${new Date().toLocaleString()}`, margin, margin+96)
      ctx.fillText(`Muestras: ${samples.length}`, margin, margin+118)

      const drawWrappedText=(textCtx,text,x,y,maxWidth,lineHeight)=>{
        if(!text){ return y }
        const words=String(text).split(/\s+/)
        let line=''
        let currentY=y
        for(const word of words){
          const testLine=line? `${line} ${word}` : word
          if(textCtx.measureText(testLine).width>maxWidth && line){
            textCtx.fillText(line, x, currentY)
            line=word
            currentY+=lineHeight
          }else{
            line=testLine
          }
        }
        if(line){
          textCtx.fillText(line, x, currentY)
          currentY+=lineHeight
        }
        return currentY
      }

      const drawCard=(card, index)=>{
        const row=Math.floor(index/cardColumns)
        const col=index%cardColumns
        const x=margin + col*(cardWidth+gap)
        const y=margin + headerHeight + row*(cardHeight+gap)
        ctx.fillStyle='#f8fafc'
        ctx.fillRect(x, y, cardWidth, cardHeight)
        ctx.strokeStyle='#e2e8f0'
        ctx.lineWidth=1
        ctx.strokeRect(x, y, cardWidth, cardHeight)
        ctx.fillStyle='#0f172a'
        ctx.font='bold 20px Arial'
        ctx.fillText(card.title, x+16, y+32)
        ctx.font='24px Arial'
        ctx.fillText(card.metric, x+16, y+62)
        let textY=y+92
        const maxWidth=cardWidth-32
        ctx.font='16px Arial'
        card.details.forEach(detail=>{
          ctx.fillStyle=detail?.color || '#475569'
          textY=drawWrappedText(ctx, detail?.text || '', x+16, textY, maxWidth, 20)
          textY+=6
        })
      }

      cards.forEach((card,idx)=>drawCard(card, idx))

      const chartY=margin + panelHeight + chartSpacing
      ctx.fillStyle='#f8fafc'
      ctx.fillRect(margin-8, chartY-32, chartTargetWidth+16, chartTargetHeight+48)
      ctx.strokeStyle='#e2e8f0'
      ctx.strokeRect(margin-8, chartY-32, chartTargetWidth+16, chartTargetHeight+48)
      ctx.fillStyle='#0f172a'
      ctx.font='bold 22px Arial'
      ctx.fillText('Curva de peso y flujo', margin, chartY-6)
      ctx.drawImage(chartImage, margin, chartY, chartTargetWidth, chartTargetHeight)

      const compositeUrl=canvas.toDataURL('image/png')
      const a=document.createElement('a')
      a.href=compositeUrl
      a.download='panel_grafico.png'
      a.click()
    }catch(err){
      console.error('No se pudo exportar el panel', err)
    }
  }

  function downloadResults(){
    const series=samples.map(sample=>({
      t:Number.isFinite(sample?.t)?Number(sample.t.toFixed(3)):0,
      g:Number.isFinite(sample?.g)?Number(sample.g.toFixed(3)):0,
      flow:Number.isFinite(sample?.flow)?Number(sample.flow.toFixed(3)):0
    }))
    const lastSeries=series[series.length-1] || { t:0, g:0, flow:0 }
    const serializedZoneGuide=(analysis.zoneGuide||[]).map(entry=>({
      t:Number.isFinite(entry?.t)?Number(entry.t.toFixed(3)):0,
      min:Number.isFinite(entry?.min)?Number(entry.min.toFixed(3)):0,
      max:Number.isFinite(entry?.max)?Number(entry.max.toFixed(3)):0
    }))
    const extractionDuration=analysis?.extractionDuration ?? (extractionInfo.active ? extractionInfo.duration : extractionInfo.lastDuration)
    const payload={
      generatedAt:new Date().toISOString(),
      runtime:{
        elapsed:Number.isFinite(elapsed)?Number(elapsed.toFixed(2)):0,
        extractionDuration:Number.isFinite(extractionDuration)?Number(extractionDuration.toFixed(2)):0,
        tare:{
          applied:!!tareApplied,
          value:Number.isFinite(tareValueG)?Number(tareValueG.toFixed(3)):0,
          timestamp:tareTime
        },
        lastSample:{
          t:lastSeries.t,
          netG:lastSeries.g,
          absG:Number.isFinite(absG)?Number(absG.toFixed(3)):lastSeries.g,
          flowGps:lastSeries.flow
        }
      },
      samples:{
        count:samples.length,
        series
      },
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
        extractionDuration:analysis.extractionDuration,
        totalDuration:analysis.totalDuration,
        safeFlowRange:[FLOW_OPTIMAL_MIN,FLOW_OPTIMAL_MAX],
        preinfusionThreshold:PREINFUSION_THRESHOLD,
        zoneCoverage:analysis.zoneCoverage,
        zoneAverageGap:analysis.zoneAverageGap,
        zoneMaxGap:analysis.zoneMaxGap,
        zonePresetId:analysis.zonePresetId
      },
      zonePreset:{
        id:analysis.zonePresetId,
        label:analysis.zoneLabel,
        short:analysis.zoneShort,
        description:analysis.zoneDescription,
        envelope:(activeZone?.envelope||[]).map(point=>(
          { progress:point.progress, min:point.min, max:point.max }
        ))
      },
      zoneGuide:serializedZoneGuide,
      narratives:{
        hydraulic:analysis.hydraulicSummary,
        channeling:analysis.channelingSummary,
        distribution:analysis.flowDistributionSummary,
        zone:analysis.zoneSummary
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

  function triggerImportResults(){
    if(importInputRef.current){
      importInputRef.current.value=''
      importInputRef.current.click()
    }
  }

  async function handleImportResults(event){
    const file=event.target?.files?.[0]
    if(!file) return
    try{
      const text=await file.text()
      const parsed=JSON.parse(text)
      const seriesSource=Array.isArray(parsed?.samples?.series)?parsed.samples.series:
        Array.isArray(parsed?.series)?parsed.series:
        Array.isArray(parsed?.sampleSeries)?parsed.sampleSeries:
        (Array.isArray(parsed?.samples)&&parsed.samples.length&&typeof parsed.samples[0]==='object'?parsed.samples:[])
      const sanitized=seriesSource.map(item=>{
        const t=parseNumber(item?.t ?? item?.time ?? item?.seconds ?? item?.timestamp)
        const g=parseNumber(item?.g ?? item?.net ?? item?.netG ?? item?.weight ?? item?.value)
        const flowValue=parseNumber(item?.flow ?? item?.flowGps ?? item?.f ?? item?.rate)
        return Number.isFinite(t) && Number.isFinite(g) ? {
          t,
          g,
          flow:Number.isFinite(flowValue)?flowValue:null
        } : null
      }).filter(Boolean)
      if(!sanitized.length){
        throw new Error('El archivo no contiene muestras válidas.')
      }
      const sorted=sanitized.sort((a,b)=>a.t-b.t)
      let previous=null
      for(const sample of sorted){
        if(!Number.isFinite(sample.flow) && previous){
          const dt=Math.max(1e-3, sample.t-previous.t)
          sample.flow=(sample.g-previous.g)/dt
        }
        if(!Number.isFinite(sample.flow)){
          sample.flow=0
        }
        sample.t=Number(sample.t.toFixed(3))
        sample.g=Number(sample.g.toFixed(3))
        sample.flow=Number(sample.flow.toFixed(3))
        previous=sample
      }
      const finalSample=sorted[sorted.length-1]
      const runtime=parsed?.runtime || {}
      const tareMeta=runtime?.tare || {}
      const zoneId=parsed?.metrics?.zonePresetId || parsed?.zonePreset?.id
      const importElapsedValue=parseNumber(runtime?.elapsed)
      const importExtractionValue=Number.isFinite(runtime?.extractionDuration)?Number(runtime.extractionDuration):parseNumber(parsed?.metrics?.extractionDuration)
      const importAbsValue=parseNumber(runtime?.lastSample?.absG ?? runtime?.absoluteWeight)
      const importFlowValue=parseNumber(runtime?.lastSample?.flowGps ?? runtime?.flow)
      const tareValueValue=parseNumber(tareMeta?.value)
      const importElapsed=Number.isFinite(importElapsedValue)?importElapsedValue:finalSample.t
      const importExtraction=Number.isFinite(importExtractionValue)?importExtractionValue:null

      resetFilters()
      runningRef.current=false
      setRunning(false)
      startTimeRef.current=null
      lastCapturedRef.current=null
      flowRef.current={ time:null, net:finalSample.g }
      extractionRef.current={ baseline:finalSample.g, hasBaseline:true, active:false, start:0, lastRiseTime:performance.now(), lastRiseWeight:finalSample.g }

      setSamples(sorted)
      setNetG(Number(finalSample.g.toFixed(2)))
      const resolvedAbs=Number.isFinite(importAbsValue)?importAbsValue:finalSample.g
      const resolvedFlow=Number.isFinite(importFlowValue)?importFlowValue:finalSample.flow
      setAbsG(Number(resolvedAbs.toFixed(2)))
      setFlowGps(Number(resolvedFlow.toFixed(3)))
      setElapsed(Number(importElapsed.toFixed(2)))
      setExtractionInfo({active:false,duration:0,lastDuration:Number.isFinite(importExtraction)?Number(importExtraction.toFixed(2)):0})
      setTareApplied(Boolean(tareMeta?.applied))
      setTareValueG(Number.isFinite(tareValueValue)?Number(tareValueValue.toFixed(2)):0)
      setTareTime(tareMeta?.timestamp || null)
      if(zoneId && FLOW_ZONE_PRESETS[zoneId]){
        setZonePreset(zoneId)
      }
      setSimulatorStatus('Datos importados para visualización')
      setErrorMsg('')
    }catch(err){
      console.error('No se pudo importar datos', err)
      alert(`No se pudo importar el archivo: ${err?.message || err}`)
    }finally{
      if(event?.target){ event.target.value='' }
    }
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
    if(!running && samples.length===0){
      setElapsed(0)
    }
  },[running, samples])

  function simulateExtraction(mode){
    const result=generateSimulatedExtraction(mode)
    resetFilters()
    runningRef.current=false
    setRunning(false)
    startTimeRef.current=null
    lastCapturedRef.current=null
    extractionRef.current={ baseline:0, hasBaseline:true, active:false, start:0, lastRiseTime:0, lastRiseWeight:0 }
    flowRef.current={ time:null, net:result.finalWeight }
    setSamples(result.samples)
    setAbsG(Number(result.finalWeight.toFixed(2)))
    setNetG(Number(result.finalWeight.toFixed(2)))
    setFlowGps(0)
    setElapsed(Number(result.totalDuration.toFixed(2)))
    setExtractionInfo({active:false,duration:0,lastDuration:result.extractionDuration})
    setTareApplied(true)
    setTareValueG(0)
    setTareTime(new Date().toISOString())
    setErrorMsg('')
    setSimulatorStatus(`Simulación ${mode==='optimal'?'en rango':`fuera de rango (${result.profileLabel})`} lista`)
  }

  return (
    <div className="container">
      <input ref={importInputRef} type="file" accept="application/json" style={{display:'none'}} onChange={handleImportResults} />
      <div className="card">
        <div className="row" style={{justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div className="row" style={{alignItems:'center',gap:12}}>
            <img src={logo} alt="Smart Espresso Tracker" className="logo" />
            <div>
              <h1 style={{margin:'0 0 4px',fontSize:'1.8rem'}}>Smart Espresso Tracker</h1>
              <div className="sub">Mentor Coffee Scale • Web Bluetooth</div>
            </div>
          </div>
          <div className="row" style={{gap:12,alignItems:'flex-end',justifyContent:'flex-end'}}>
            <div className="simulator-box">
              <div className="sim-label">Simulador</div>
              <div className="row" style={{gap:6,flexWrap:'nowrap'}}>
                <button onClick={()=>simulateExtraction('optimal')} disabled={running||connecting||connected} title={connected?'Desconecta la balanza para simular.':''}>En rango</button>
                <button onClick={()=>simulateExtraction('off')} disabled={running||connecting||connected} title={connected?'Desconecta la balanza para simular.':''}>Fuera de rango</button>
              </div>
              {simulatorStatus && <div className="sim-status">{simulatorStatus}</div>}
            </div>
            <span className="pill">{connected?`Conectado${deviceName?` a ${deviceName}`:''}`:'Desconectado'}</span>
          </div>
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
          <div className="row" style={{justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
            <div className="row" style={{alignItems:'center',gap:12,flexWrap:'wrap'}}>
              <h3 style={{margin:'0'}}>Panel de resultados</h3>
              <div className="row" style={{alignItems:'center',gap:8}}>
                <label htmlFor="zonePreset" className="sub">Zona segura</label>
                <select id="zonePreset" value={zonePreset} onChange={e=>setZonePreset(e.target.value)}>
                  {Object.values(FLOW_ZONE_PRESETS).map(zone=>(
                    <option key={zone.id} value={zone.id}>{zone.optionLabel}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row" style={{gap:8,flexWrap:'wrap'}}>
              <button onClick={triggerImportResults}>Importar datos (JSON)</button>
              <button onClick={downloadPanelComposite} disabled={samples.length===0}>Exportar panel + gráfico</button>
              <button onClick={downloadResults} disabled={samples.length===0}>Exportar datos (JSON)</button>
            </div>
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
            <div className="card" style={{padding:'16px'}}>
              <div className="sub">Zona segura de caudal ({analysis.zoneShort})</div>
              <div className="metric-sm">{analysis.zoneCoverage.inside.toFixed(0)} <span className="sub">% en zona</span></div>
              <div className="small">{analysis.zoneLabel}</div>
              {analysis.zoneDescription && <div className="small">{analysis.zoneDescription}</div>}
              <div className="small">Debajo: {analysis.zoneCoverage.below.toFixed(0)}% • Encima: {analysis.zoneCoverage.above.toFixed(0)}%</div>
              <div className="small">Brecha media: {analysis.zoneAverageGap.toFixed(2)} g/s • Máx brecha: {analysis.zoneMaxGap.toFixed(2)} g/s</div>
              <div className="small">{analysis.zoneSummary}</div>
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

