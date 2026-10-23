import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  FileVideo, 
  Play, 
  Sliders, 
  CheckCircle2, 
  AlertCircle, 
  Info,
  RefreshCw,
  Camera,
  Radio,
  Video as VideoIcon,
  Square,
  Zap,
  Gauge,
  Car,
  Bus,
  Truck,
  Bike,
  AlertTriangle,
  ArrowUpRight,
  TrendingUp,
  RotateCcw
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  BarChart, 
  Bar, 
  Cell 
} from 'recharts';
import { api } from '../services/api';
import { ProcessingJob, VideoMetadata, ViewPage } from '../types';
import { VideoPlayerWithOverlay } from '../components/VideoPlayerWithOverlay';

interface VideoAnalysisProps {
  onAnalysisStarted: (videoId: string) => void;
  activeJobId: string | null;
  onSelectView: (view: ViewPage) => void;
}

export const VideoAnalysis: React.FC<VideoAnalysisProps> = ({
  onAnalysisStarted,
  activeJobId,
  onSelectView
}) => {
  // Mode selection: Uploaded Video Live Analysis vs Live RTSP/Webcam stream
  const [activeTab, setActiveTab] = useState<'upload' | 'live'>('upload');

  // Video File states
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedMeta, setUploadedMeta] = useState<VideoMetadata | null>(null);
  const [videoId, setVideoId] = useState<string | null>(activeJobId);
  const [error, setError] = useState<string | null>(null);

  // Config parameters
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0.35);
  const [maxMissedFrames, setMaxMissedFrames] = useState<number>(30);
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number | ''>(15);
  const [expectedDirection, setExpectedDirection] = useState<string>('EAST');
  const [detectionInterval, setDetectionInterval] = useState<number>(1);

  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [videoGenMessage, setVideoGenMessage] = useState<string | null>(null);

  // Live Concurrent AI Telemetry states
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [liveTracks, setLiveTracks] = useState<any[]>([]);
  const [countingLine, setCountingLine] = useState<any>(null);
  const [lanePolygons, setLanePolygons] = useState<any>(null);

  const [kpis, setKpis] = useState({
    totalVehicles: 0,
    currentVehicles: 0,
    cars: 0,
    buses: 0,
    trucks: 0,
    motorcycles: 0,
    averageSpeed: null as number | null,
    density: 'LOW',
    congestion: 'NORMAL'
  });

  const [flowTimeSeries, setFlowTimeSeries] = useState<Array<{ time: string; count: number }>>([]);
  const [laneCounts, setLaneCounts] = useState<Record<string, number>>({});
  const [recentEvents, setRecentEvents] = useState<any[]>([]);
  const [nativeResolution, setNativeResolution] = useState<{ width: number; height: number } | null>(null);

  // Live Camera / RTSP stream states
  const [isLiveActive, setIsLiveActive] = useState<boolean>(false);
  const [streamSource, setStreamSource] = useState<'webcam' | 'rtsp'>('webcam');
  const [rtspUrl, setRtspUrl] = useState<string>('rtsp://admin:pass@192.168.1.100:554/live');
  const [cameraMetrics, setCameraMetrics] = useState<{
    activeVehicles: number;
    averageSpeed: number | null;
    fps: number;
    frameIdx: number;
  }>({ activeVehicles: 0, averageSpeed: null, fps: 30, frameIdx: 0 });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveWsRef = useRef<{ sendCommand: (cmd: any) => void; close: () => void } | null>(null);
  const cameraWsRef = useRef<{ sendFrame: (b64: string) => void; sendRtspUrl: (url: string) => void; close: () => void } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraIntervalRef = useRef<any>(null);

  // Sync videoId when activeJobId prop changes (e.g. from History or Dashboard)
  useEffect(() => {
    if (activeJobId && activeJobId !== videoId) {
      setVideoId(activeJobId);
      setIsAnalyzing(false);
      setIsCompleted(false);
      setLiveTracks([]);
      setError(null);
    }
  }, [activeJobId]);

  // Fetch session metadata if videoId is active
  useEffect(() => {
    if (!videoId) return;
    api.getJobStatus(videoId)
      .then((res) => {
        if (res.job?.summary) {
          setIsCompleted(true);
        }
      })
      .catch(() => {});
  }, [videoId]);

  // Clean up WebSockets on unmount
  useEffect(() => {
    return () => {
      if (liveWsRef.current) liveWsRef.current.close();
      stopCameraStream();
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
      setRecentEvents([]);
      setFlowTimeSeries([]);
      setIsCompleted(false);
      setLiveTracks([]);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const res = await api.uploadVideo(file);
      setUploadedMeta(res.metadata);
      setVideoId(res.video_id);
      setUploading(false);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to upload video');
      setUploading(false);
    }
  };

  // Start Live Analysis over WebSocket concurrent with HTML5 Video Playback
  const handleStartLiveAnalysis = () => {
    if (!videoId) return;
    setError(null);
    setRecentEvents([]);
    setFlowTimeSeries([]);
    setLiveTracks([]);
    setIsCompleted(false);
    setIsAnalyzing(true);

    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }

    if (liveWsRef.current) liveWsRef.current.close();

    const ws = api.connectLiveAnalysisWS(videoId, (data) => {
      if (data.type === 'telemetry') {
        setLiveTracks(data.tracks || []);
        setCountingLine(data.counting_line);
        setLanePolygons(data.lane_polygons);

        const classCounts = data.class_counts || {};
        setKpis({
          totalVehicles: data.total_vehicles || 0,
          currentVehicles: data.active_vehicles || 0,
          cars: classCounts.car || 0,
          buses: classCounts.bus || 0,
          trucks: classCounts.truck || 0,
          motorcycles: (classCounts.motorcycle || 0) + (classCounts.bicycle || 0),
          averageSpeed: data.average_speed,
          density: data.density || 'LOW',
          congestion: data.congestion || 'NORMAL'
        });

        if (data.lane_counts) setLaneCounts(data.lane_counts);

        if (data.video_width && data.video_height) {
          setNativeResolution({ width: data.video_width, height: data.video_height });
        }

        if (data.events && data.events.length > 0) {
          setRecentEvents((prev) => {
            const seen = new Set(prev.map((event) =>
              `${event.event_type}:${event.track_id ?? 'traffic'}:${event.frame_idx ?? event.timestamp}`
            ));
            const freshEvents = data.events.filter((event: any) => {
              const key = `${event.event_type}:${event.track_id ?? 'traffic'}:${event.frame_idx ?? event.timestamp}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            return [...freshEvents, ...prev].slice(0, 10);
          });
        }

        // Add to time series flow chart
        if (data.timestamp !== undefined) {
          const timeLabel = `${Math.floor(data.timestamp / 60)}:${String(Math.floor(data.timestamp % 60)).padStart(2, '0')}`;
          setFlowTimeSeries(prev => {
            const next = [...prev, { time: timeLabel, count: data.active_vehicles || 0 }];
            return next.slice(-20);
          });
        }

      } else if (data.type === 'completed') {
        setIsAnalyzing(false);
        setIsCompleted(true);
      } else if (data.type === 'error' || data.error) {
        setError(data.error || 'Live analysis failed. Please retry.');
        setIsAnalyzing(false);
      }
    });

    liveWsRef.current = ws;

    ws.sendCommand({
      action: 'start',
      confidence: confidenceThreshold,
      interval: detectionInterval,
      pixels_per_meter: pixelsPerMeter !== '' ? Number(pixelsPerMeter) : null,
      direction: expectedDirection
    });

    onAnalysisStarted(videoId);
  };

  const handlePauseAnalysis = () => {
    if (liveWsRef.current) {
      liveWsRef.current.sendCommand({ action: 'pause' });
    }
  };

  const handleResumeAnalysis = () => {
    if (liveWsRef.current) {
      liveWsRef.current.sendCommand({ action: 'resume' });
    }
  };

  const handleStopAnalysis = () => {
    setIsAnalyzing(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
    if (liveWsRef.current) {
      liveWsRef.current.sendCommand({ action: 'stop' });
      liveWsRef.current.close();
      liveWsRef.current = null;
    }
  };

  const handleSeek = (seconds: number) => {
    if (liveWsRef.current) {
      liveWsRef.current.sendCommand({ action: 'seek', time: seconds });
    }
  };

  const handleSyncTime = (seconds: number) => {
    if (liveWsRef.current && isAnalyzing) {
      liveWsRef.current.sendCommand({ action: 'sync', time: seconds });
    }
  };

  const handleGenerateProcessedVideo = async () => {
    if (!videoId) return;
    setGeneratingVideo(true);
    setVideoGenMessage('Generating annotated video in background...');
    try {
      await api.generateProcessedVideo(videoId);
      setVideoGenMessage('Video generation task started. It will be ready shortly.');
    } catch (err: any) {
      setVideoGenMessage('Failed to start video generation task.');
    } finally {
      setGeneratingVideo(false);
    }
  };

  // Live Camera / RTSP stream handler
  const startCameraStream = async () => {
    setError(null);
    try {
      setIsLiveActive(true);
      const ws = api.connectLiveStreamWebSocket((data) => {
        if (data && !data.error) {
          setCameraMetrics({
            activeVehicles: data.active_vehicles || 0,
            averageSpeed: data.average_speed,
            fps: 30,
            frameIdx: data.frame_idx || 0
          });
          setLiveTracks(data.tracks || []);
        } else if (data?.error) {
          setError(data.error);
        }
      });
      cameraWsRef.current = ws;

      if (streamSource === 'webcam') {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: { ideal: 1280 }, height: { ideal: 720 } } 
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }

        const captureCanvas = document.createElement('canvas');
        const captureCtx = captureCanvas.getContext('2d');

        cameraIntervalRef.current = setInterval(() => {
          if (videoRef.current && cameraWsRef.current && videoRef.current.readyState >= 2) {
            captureCanvas.width = videoRef.current.videoWidth || 640;
            captureCanvas.height = videoRef.current.videoHeight || 360;
            if (captureCtx) {
              captureCtx.drawImage(videoRef.current, 0, 0, captureCanvas.width, captureCanvas.height);
              const b64 = captureCanvas.toDataURL('image/jpeg', 0.6);
              cameraWsRef.current.sendFrame(b64);
            }
          }
        }, 100);
      } else if (streamSource === 'rtsp') {
        cameraIntervalRef.current = setInterval(() => {
          if (cameraWsRef.current) {
            cameraWsRef.current.sendRtspUrl(rtspUrl);
          }
        }, 100);
      }

    } catch (err: any) {
      setError('Could not access camera feed. Please check permissions or RTSP URL formatting.');
      setIsLiveActive(false);
    }
  };

  const stopCameraStream = () => {
    setIsLiveActive(false);
    if (cameraIntervalRef.current) {
      clearInterval(cameraIntervalRef.current);
      cameraIntervalRef.current = null;
    }
    if (cameraWsRef.current) {
      cameraWsRef.current.close();
      cameraWsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      
      {/* Header & Mode Switcher */}
      <div className="flex items-center justify-between border-b border-[#192c43] pb-5">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">
            Traffic Video Analysis & Live Telemetry
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Real-time YOLO vehicle detection, 2D Kalman tracking, & dynamic overlay engine.
          </p>
        </div>

        <div className="flex items-center p-1 bg-[#0a111a] rounded-xl border border-[#192c43]">
          <button
            onClick={() => { setActiveTab('upload'); stopCameraStream(); }}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'upload' 
                ? 'bg-orange-500 text-white shadow-md' 
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <VideoIcon className="w-3.5 h-3.5" />
            <span>Upload Traffic Video</span>
          </button>

          <button
            onClick={() => { setActiveTab('live'); handleStopAnalysis(); }}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'live' 
                ? 'bg-orange-500 text-white shadow-md' 
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Live Camera / RTSP</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs flex items-center space-x-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* MODE 1: RECORDED TRAFFIC VIDEO WITH LIVE CONCURRENT AI ANALYSIS */}
      {activeTab === 'upload' && (
        <div className="space-y-6">
          
          {/* TOP SECTION: LIVE VIDEO ANALYSIS + LIVE EVENTS & TRAFFIC ALERTS BESIDE IT */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            
            {/* Live Video Analysis Section (Left, lg:col-span-9) */}
            <div className="lg:col-span-9 space-y-4">
              {(videoId || file) ? (
                <VideoPlayerWithOverlay
                  videoId={videoId || ''}
                  tracks={liveTracks}
                  countingLine={countingLine}
                  lanePolygons={lanePolygons}
                  isAnalyzing={isAnalyzing}
                  isCompleted={isCompleted}
                  onStartLiveAnalysis={handleStartLiveAnalysis}
                  onPauseAnalysis={handlePauseAnalysis}
                  onResumeAnalysis={handleResumeAnalysis}
                  onStopAnalysis={handleStopAnalysis}
                  onSeek={handleSeek}
                  onSyncTime={handleSyncTime}
                  nativeWidth={nativeResolution?.width}
                  nativeHeight={nativeResolution?.height}
                  onVideoEnded={() => {
                    setIsAnalyzing(false);
                    setIsCompleted(true);
                  }}
                  videoRef={videoRef}
                />
              ) : (
                <div className="itms-card p-10 text-center space-y-4">
                  <div className="p-4 rounded-2xl bg-orange-500/10 text-orange-500 inline-block">
                    <FileVideo className="w-12 h-12" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">Select or Drag Traffic Video File</h3>
                    <p className="text-xs text-slate-400 mt-1">Upload a traffic video to play in the Dashboard with live concurrent AI analysis.</p>
                  </div>

                  <input
                    type="file"
                    accept="video/*"
                    onChange={handleFileChange}
                    className="hidden"
                    id="video-upload-input"
                  />
                  <label
                    htmlFor="video-upload-input"
                    className="inline-block px-6 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-xs uppercase tracking-wider cursor-pointer shadow-lg shadow-orange-500/20 transition"
                  >
                    Browse Video Files
                  </label>
                </div>
              )}

              {/* Upload Button step if file chosen but not yet uploaded */}
              {file && !uploadedMeta && !videoId && (
                <div className="flex justify-center">
                  <button
                    onClick={handleUpload}
                    disabled={uploading}
                    className="px-8 py-3.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-xs uppercase tracking-wider shadow-lg shadow-orange-500/20 flex items-center space-x-2 transition"
                  >
                    {uploading ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Uploading & Preparing Feed...</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        <span>Upload Video Feed</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Live Events & Traffic Alerts Section Beside the Video (Right, lg:col-span-3 - Compact) */}
            <div className="lg:col-span-3">
              <div className="itms-card p-3.5 flex flex-col space-y-2.5 h-[410px] lg:h-[420px]">
                <div className="flex items-center justify-between border-b border-[#192c43] pb-2">
                  <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider font-mono flex items-center space-x-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                    <span>Live Alerts</span>
                  </h3>
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                    recentEvents.length > 0 
                      ? 'text-amber-400 bg-amber-500/10 border-amber-500/20 animate-pulse'
                      : 'text-slate-400 bg-slate-500/10 border-slate-500/20'
                  }`}>
                    {recentEvents.length}
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2 font-mono text-xs pr-1">
                  {recentEvents.length > 0 ? (
                    recentEvents.map((evt, idx) => (
                      <div 
                        key={idx} 
                        className={`p-2.5 rounded-lg border flex items-start space-x-2 transition ${
                          evt.event_type === 'WRONG_WAY' || evt.severity === 'HIGH' || evt.severity === 'CRITICAL'
                            ? 'bg-red-500/10 border-red-500/30'
                            : 'bg-[#0c1624] border-[#192c43]'
                        }`}
                      >
                        <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
                          evt.event_type === 'WRONG_WAY' || evt.severity === 'HIGH' || evt.severity === 'CRITICAL' ? 'text-red-400' : 'text-amber-400'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-slate-200 font-bold text-[11px] leading-snug">
                            {evt.message || evt.event_type}
                          </p>
                          <div className="flex items-center flex-wrap gap-x-2 text-[9px] text-slate-400 mt-1">
                            <span>⏱️ {evt.timestamp || `Frame #${evt.frame_idx}`}</span>
                            {evt.lane && <span>🛣️ {evt.lane}</span>}
                            {evt.class_name && <span className="uppercase text-orange-400 font-bold">{evt.class_name}</span>}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center p-4 space-y-1.5 text-slate-500 min-h-[160px]">
                      <AlertTriangle className="w-6 h-6 text-slate-600/60" />
                      <p className="text-[11px] font-mono">No violation events yet.</p>
                      <p className="text-[9px] text-slate-600 max-w-[160px]">
                        {isAnalyzing ? 'Monitoring feed for violations...' : 'Start analysis to view alerts.'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>

          {/* LIVE TELEMETRY KPI CARDS ROW */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-slate-400">Total Vehicles</span>
              <span className="text-2xl font-bold text-white font-mono mt-1">{kpis.totalVehicles}</span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-cyan-400">Current Active</span>
              <span className="text-2xl font-bold text-cyan-400 font-mono mt-1">{kpis.currentVehicles}</span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-slate-400">Cars</span>
              <span className="text-2xl font-bold text-white font-mono mt-1">{kpis.cars}</span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-teal-400">Buses</span>
              <span className="text-2xl font-bold text-teal-400 font-mono mt-1">{kpis.buses}</span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-orange-400">Trucks</span>
              <span className="text-2xl font-bold text-orange-400 font-mono mt-1">{kpis.trucks}</span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-purple-400">Motorcycles</span>
              <span className="text-2xl font-bold text-purple-400 font-mono mt-1">{kpis.motorcycles}</span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-slate-400">Avg Speed</span>
              <span className="text-xl font-bold text-white font-mono mt-1">
                {kpis.averageSpeed !== null ? `${kpis.averageSpeed} km/h` : 'Calibrating'}
              </span>
            </div>
            <div className="itms-card p-3 flex flex-col justify-between">
              <span className="text-[10px] font-medium text-slate-400">Congestion</span>
              <span className="text-sm font-bold text-emerald-400 font-mono mt-1">{kpis.congestion}</span>
            </div>
          </div>

          {/* BOTTOM ANALYTICS & CONTROLS GRID */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Real-Time Traffic Density Flow Chart (Left, lg:col-span-7) */}
            <div className="lg:col-span-7 space-y-6">
              <div className="itms-card p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider font-mono flex items-center space-x-2">
                    <TrendingUp className="w-4 h-4 text-orange-500" />
                    <span>Real-Time Traffic Density Flow</span>
                  </h3>
                  <span className="text-[10px] font-mono text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20">
                    Live Telemetry
                  </span>
                </div>

                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={flowTimeSeries.length > 0 ? flowTimeSeries : [{ time: '0:00', count: 0 }]}>
                      <XAxis dataKey="time" stroke="#475569" fontSize={10} />
                      <YAxis stroke="#475569" fontSize={10} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#0a111a', borderColor: '#192c43', borderRadius: '8px', fontSize: '11px' }}
                      />
                      <Line type="monotone" dataKey="count" stroke="#f97316" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Parameters & Detection Controls (Right, lg:col-span-5) */}
            <div className="lg:col-span-5 space-y-6">
              <div className="itms-card p-6 space-y-4">
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider font-mono flex items-center space-x-2">
                  <Sliders className="w-4 h-4 text-orange-500" />
                  <span>Parameters & Detection Controls</span>
                </h3>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block text-slate-400 mb-1 font-mono text-[11px]">Detection Interval</label>
                    <select
                      value={detectionInterval}
                      onChange={(e) => setDetectionInterval(parseInt(e.target.value))}
                      className="w-full bg-[#0a111a] border border-[#192c43] rounded-xl px-3 py-2 text-slate-100 font-mono text-xs outline-none focus:border-orange-500"
                    >
                      <option value={2}>2 - Maximum Accuracy (YOLO every 2nd frame)</option>
                      <option value={3}>3 - High Accuracy</option>
                      <option value={5}>5 - Balanced Default (YOLO every 5th frame + Kalman)</option>
                      <option value={8}>8 - High Speed</option>
                      <option value={10}>10 - Ultra Fast</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1 font-mono text-[11px]">YOLO Confidence Threshold</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.1"
                      max="0.9"
                      value={confidenceThreshold}
                      onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                      className="w-full bg-[#0a111a] border border-[#192c43] rounded-xl px-3 py-2 text-slate-100 font-mono text-xs outline-none focus:border-orange-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1 font-mono text-[11px]">Pixels-Per-Meter Scale</label>
                    <input
                      type="number"
                      step="0.5"
                      value={pixelsPerMeter}
                      onChange={(e) => setPixelsPerMeter(e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-[#0a111a] border border-[#192c43] rounded-xl px-3 py-2 text-slate-100 font-mono text-xs outline-none focus:border-orange-500"
                    />
                  </div>
                </div>

                {isCompleted && (
                  <div className="pt-2 space-y-2">
                    <button
                      onClick={() => onSelectView('dashboard')}
                      className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-xs uppercase tracking-wider shadow-md transition"
                    >
                      VIEW DASHBOARD ANALYTICS
                    </button>

                    <button
                      onClick={handleGenerateProcessedVideo}
                      disabled={generatingVideo}
                      className="w-full py-3 rounded-xl bg-[#122238] hover:bg-[#182c48] text-slate-200 font-bold text-xs uppercase tracking-wider border border-[#192c43] transition flex items-center justify-center space-x-2"
                    >
                      <VideoIcon className="w-4 h-4 text-orange-500" />
                      <span>GENERATE PROCESSED VIDEO</span>
                    </button>

                    {videoGenMessage && (
                      <p className="text-[10px] text-orange-300 font-mono bg-orange-500/10 p-2 rounded border border-orange-500/20">
                        {videoGenMessage}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* MODE 2: LIVE CAMERA / RTSP STREAM */}
      {activeTab === 'live' && (
        <div className="space-y-6">
          <div className="itms-card p-8 space-y-6">
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider font-mono flex items-center space-x-2">
              <Camera className="w-4 h-4 text-orange-500" />
              <span>IP Traffic Camera / Webcam Telemetry</span>
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              <div className="lg:col-span-7">
                <div className="relative aspect-video bg-black rounded-2xl overflow-hidden border border-[#192c43]">
                  <video ref={videoRef} className="w-full h-full object-cover" />
                  <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none w-full h-full" />
                </div>
              </div>

              <div className="lg:col-span-5 space-y-4">
                <div className="flex space-x-2">
                  <button
                    onClick={() => setStreamSource('webcam')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold border transition ${
                      streamSource === 'webcam' ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#0a111a] border-[#192c43] text-slate-400'
                    }`}
                  >
                    Webcam
                  </button>
                  <button
                    onClick={() => setStreamSource('rtsp')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold border transition ${
                      streamSource === 'rtsp' ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#0a111a] border-[#192c43] text-slate-400'
                    }`}
                  >
                    RTSP Feed
                  </button>
                </div>

                {streamSource === 'rtsp' && (
                  <input
                    type="text"
                    value={rtspUrl}
                    onChange={(e) => setRtspUrl(e.target.value)}
                    className="w-full bg-[#0a111a] border border-[#192c43] rounded-xl px-4 py-2.5 text-slate-100 text-xs font-mono"
                    placeholder="rtsp://admin:pass@ip:554/live"
                  />
                )}

                {!isLiveActive ? (
                  <button
                    onClick={startCameraStream}
                    className="w-full py-3.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-xs uppercase tracking-wider shadow-lg shadow-orange-500/20"
                  >
                    Start Stream Telemetry
                  </button>
                ) : (
                  <button
                    onClick={stopCameraStream}
                    className="w-full py-3.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-400 font-bold text-xs uppercase tracking-wider"
                  >
                    Stop Stream
                  </button>
                )}

                <div className="p-4 rounded-xl bg-[#0c1624] border border-[#192c43] space-y-2 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Active Vehicles</span>
                    <span className="text-white font-bold">{cameraMetrics.activeVehicles}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Average Speed</span>
                    <span className="text-white font-bold">{cameraMetrics.averageSpeed ? `${cameraMetrics.averageSpeed} km/h` : 'Calibrating'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
