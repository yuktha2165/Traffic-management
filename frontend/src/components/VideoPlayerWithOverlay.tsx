import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Square, RefreshCw, Activity, ShieldAlert, Sparkles, CheckCircle2, Tag, Check, X, Edit3 } from 'lucide-react';
import { api } from '../services/api';

interface VideoPlayerWithOverlayProps {
  videoId: string;
  videoUrl?: string;
  tracks: any[];
  countingLine?: any;
  lanePolygons?: any;
  isAnalyzing: boolean;
  isCompleted?: boolean;
  onStartLiveAnalysis: () => void;
  onPauseAnalysis: () => void;
  onResumeAnalysis: () => void;
  onStopAnalysis: () => void;
  onSeek?: (seconds: number) => void;
  onSyncTime?: (seconds: number) => void;
  onVideoEnded?: () => void;
  videoRef: any;
  nativeWidth?: number;
  nativeHeight?: number;
}

export const VideoPlayerWithOverlay: React.FC<VideoPlayerWithOverlayProps> = ({
  videoId,
  videoUrl,
  tracks,
  countingLine,
  lanePolygons,
  isAnalyzing,
  isCompleted = false,
  onStartLiveAnalysis,
  onPauseAnalysis,
  onResumeAnalysis,
  onStopAnalysis,
  onSeek,
  onSyncTime,
  onVideoEnded,
  videoRef,
  nativeWidth,
  nativeHeight
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [customVehicleIds, setCustomVehicleIds] = useState<Record<number, string>>({});
  const [selectedTrack, setSelectedTrack] = useState<any | null>(null);
  const [customIdInput, setCustomIdInput] = useState<string>('');
  const [hoveredTrackId, setHoveredTrackId] = useState<number | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const lastSyncRef = useRef<number>(0);

  const resolvedVideoUrl = videoUrl || (videoId ? api.getVideoFileUrl(videoId) : '');

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    const updateLayout = () => setLayoutRevision((revision) => revision + 1);
    const observer = new ResizeObserver(updateLayout);
    observer.observe(container);
    video.addEventListener('loadedmetadata', updateLayout);

    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', updateLayout);
    };
  }, [videoRef]);

  // Render transparent overlay canvas with exact object-contain letterbox calibration
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1. Container display dimensions
    const containerW = video.clientWidth || 640;
    const containerH = video.clientHeight || 360;
    if (canvas.width !== containerW || canvas.height !== containerH) {
      canvas.width = containerW;
      canvas.height = containerH;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 2. Original video resolution
    const naturalW = video.videoWidth || nativeWidth || 1280;
    const naturalH = video.videoHeight || nativeHeight || 720;
    if (naturalW <= 0 || naturalH <= 0) return;

    // 3. Exact Letterbox / Pillarbox Geometry for CSS object-contain
    const videoAspect = naturalW / naturalH;
    const containerAspect = containerW / containerH;

    let renderW = containerW;
    let renderH = containerH;
    let offsetX = 0;
    let offsetY = 0;

    if (containerAspect > videoAspect) {
      // Pillarbox: container is wider than video (bars on left and right)
      renderH = containerH;
      renderW = containerH * videoAspect;
      offsetX = (containerW - renderW) / 2;
      offsetY = 0;
    } else {
      // Letterbox: container is taller than video (bars on top and bottom)
      renderW = containerW;
      renderH = containerW / videoAspect;
      offsetX = 0;
      offsetY = (containerH - renderH) / 2;
    }

    const scale = renderW / naturalW;

    const toCanvasX = (x: number) => offsetX + x * scale;
    const toCanvasY = (y: number) => offsetY + y * scale;

    // 4. Draw Lane Polygons / Lines if available
    if (lanePolygons && typeof lanePolygons === 'object') {
      ctx.save();
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);

      Object.entries(lanePolygons).forEach(([laneName, poly]: [string, any]) => {
        if (Array.isArray(poly) && poly.length >= 2) {
          ctx.beginPath();
          poly.forEach((pt: number[], idx: number) => {
            const px = toCanvasX(pt[0]);
            const py = toCanvasY(pt[1]);
            if (idx === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();

          // Lane Label inside calibrated area
          const firstPt = poly[0];
          ctx.fillStyle = 'rgba(6, 182, 212, 0.9)';
          ctx.font = 'bold 9px monospace';
          ctx.fillText(laneName.toUpperCase(), toCanvasX(firstPt[0]) + 4, toCanvasY(firstPt[1]) + 12);
        }
      });
      ctx.restore();
    }

    // 5. Draw Virtual Counting Line
    if (countingLine) {
      ctx.save();
      let p1x = toCanvasX(0);
      let p1y = toCanvasY(naturalH * 0.55);
      let p2x = toCanvasX(naturalW);
      let p2y = toCanvasY(naturalH * 0.55);

      if (typeof countingLine === 'object' && countingLine.y !== undefined) {
        p1y = toCanvasY(countingLine.y);
        p2y = toCanvasY(countingLine.y);
      } else if (Array.isArray(countingLine) && countingLine.length >= 2) {
        p1x = toCanvasX(countingLine[0][0]);
        p1y = toCanvasY(countingLine[0][1]);
        p2x = toCanvasX(countingLine[1][0]);
        p2y = toCanvasY(countingLine[1][1]);
      }

      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.stroke();

      // Glowing badge
      const badgeX = Math.max(offsetX + 8, p1x + 8);
      const badgeY = Math.max(offsetY, p1y - 14);
      ctx.fillStyle = '#f97316';
      ctx.fillRect(badgeX, badgeY, 110, 14);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('COUNTING LINE ──', badgeX + 4, badgeY + 10);
      ctx.restore();
    }

    // 6. Draw Vehicle Bounding Boxes & Trajectories
    tracks.forEach((t) => {
      const [x1, y1, x2, y2] = t.bbox || [0, 0, 0, 0];
      const sx1 = toCanvasX(x1);
      const sy1 = toCanvasY(y1);
      const sw = (x2 - x1) * scale;
      const sh = (y2 - y1) * scale;

      // Color mapping by vehicle class
      let primaryColor = '#06b6d4'; // Default cyan for cars
      const cls = (t.class_name || '').toLowerCase();
      if (cls.includes('bus')) primaryColor = '#0d9488';
      else if (cls.includes('truck')) primaryColor = '#f97316';
      else if (cls.includes('motorcycle') || cls.includes('bike')) primaryColor = '#a855f7';

      // Alert override
      if (t.speed_kmh && t.speed_kmh > 60) {
        primaryColor = '#ef4444';
      }

      // Draw Trajectory Trail
      if (Array.isArray(t.trajectory) && t.trajectory.length > 1) {
        ctx.save();
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.6;

        for (let i = 1; i < t.trajectory.length; i++) {
          const p1 = t.trajectory[i - 1];
          const p2 = t.trajectory[i];
          const dx = (p2[0] - p1[0]) * scale;
          const dy = (p2[1] - p1[1]) * scale;
          const dist = Math.hypot(dx, dy);

          if (dist <= 90 * scale) {
            ctx.beginPath();
            ctx.moveTo(toCanvasX(p1[0]), toCanvasY(p1[1]));
            ctx.lineTo(toCanvasX(p2[0]), toCanvasY(p2[1]));
            ctx.stroke();
          }
        }

        // Draw motion dots
        t.trajectory.forEach((pt: number[]) => {
          ctx.fillStyle = primaryColor;
          ctx.beginPath();
          ctx.arc(toCanvasX(pt[0]), toCanvasY(pt[1]), 2, 0, 2 * Math.PI);
          ctx.fill();
        });
        ctx.restore();
      }

      const isHovered = hoveredTrackId === t.track_id;
      const customId = customVehicleIds[t.track_id];
      const autoIdStr = `ID: #${String(t.track_id).padStart(2, '0')}`;
      const idLabel = customId ? `🏷️ ${customId}` : autoIdStr;

      const typeLabel = (t.class_name || 'Vehicle').toUpperCase();
      const speedLabel = t.speed_kmh ? `${Math.round(t.speed_kmh)} km/h` : 'Tracking';
      const dirArrow = t.direction === 'EAST' ? '→' : t.direction === 'WEST' ? '←' : t.direction === 'NORTH' ? '↑' : '↓';
      const metaLabel = `${typeLabel} ${dirArrow} | ${speedLabel}`;

      // Bounding Box
      ctx.save();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = isHovered ? 3.5 : 2.5;
      ctx.strokeRect(sx1, sy1, sw, sh);

      // Draw subtle glow if hovered
      if (isHovered) {
        ctx.shadowColor = primaryColor;
        ctx.shadowBlur = 8;
        ctx.strokeRect(sx1, sy1, sw, sh);
        ctx.shadowBlur = 0;
      }

      // Label Header Badges
      ctx.font = 'bold 11px monospace';
      const idWidth = ctx.measureText(idLabel).width + 12;
      ctx.font = 'bold 10px monospace';
      const metaWidth = ctx.measureText(metaLabel).width + 10;
      const badgeH = 20;
      const badgeY = Math.max(offsetY + 2, sy1 - badgeH - 3);

      // 1. Vehicle ID Pill (Left Section - Solid Vibrant Theme Color)
      ctx.fillStyle = primaryColor;
      ctx.beginPath();
      if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(sx1, badgeY, idWidth, badgeH, [4, 0, 0, 4]);
      } else {
        ctx.rect(sx1, badgeY, idWidth, badgeH);
      }
      ctx.fill();

      // Vehicle ID Text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(idLabel, sx1 + 6, badgeY + 14);

      // 2. Metadata Pill (Right Section - Dark Slate Background)
      ctx.fillStyle = 'rgba(10, 17, 26, 0.90)';
      ctx.beginPath();
      if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(sx1 + idWidth, badgeY, metaWidth, badgeH, [0, 4, 4, 0]);
      } else {
        ctx.rect(sx1 + idWidth, badgeY, metaWidth, badgeH);
      }
      ctx.fill();

      // Meta Border
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Meta Text
      ctx.fillStyle = '#cbd5e1';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(metaLabel, sx1 + idWidth + 5, badgeY + 14);

      // If hovered or custom assigned, show indicator
      if (isHovered) {
        ctx.fillStyle = '#f97316';
        ctx.font = 'bold 9px sans-serif';
        const hintText = '✎ Click to edit ID';
        const hintW = ctx.measureText(hintText).width + 8;
        ctx.fillRect(sx1, badgeY - 14, hintW, 13);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(hintText, sx1 + 4, badgeY - 4);
      }

      ctx.restore();
    });

  }, [tracks, countingLine, lanePolygons, nativeWidth, nativeHeight, customVehicleIds, hoveredTrackId, layoutRevision]);

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().then(() => {
        setIsPlaying(true);
        if (isAnalyzing) onResumeAnalysis();
        else onStartLiveAnalysis();
      }).catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
      onPauseAnalysis();
    }
  };

  // Find vehicle track directly under cursor
  const getTrackAtCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !tracks || tracks.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const clickY = clientY - rect.top;

    const naturalW = nativeWidth || 1280;
    const naturalH = nativeHeight || 720;
    const containerW = rect.width;
    const containerH = rect.height;

    const videoAspect = naturalW / naturalH;
    const containerAspect = containerW / containerH;

    let renderW = containerW;
    let renderH = containerH;
    let offsetX = 0;
    let offsetY = 0;

    if (containerAspect > videoAspect) {
      renderH = containerH;
      renderW = containerH * videoAspect;
      offsetX = (containerW - renderW) / 2;
    } else {
      renderW = containerW;
      renderH = containerW / videoAspect;
      offsetY = (containerH - renderH) / 2;
    }

    const scale = renderW / naturalW;
    const toCanvasX = (x: number) => offsetX + x * scale;
    const toCanvasY = (y: number) => offsetY + y * scale;

    for (let i = tracks.length - 1; i >= 0; i--) {
      const t = tracks[i];
      const [x1, y1, x2, y2] = t.bbox || [0, 0, 0, 0];
      const sx1 = toCanvasX(x1);
      const sy1 = toCanvasY(y1);
      const sw = (x2 - x1) * scale;
      const sh = (y2 - y1) * scale;
      const badgeH = 26;

      if (
        clickX >= sx1 - 4 &&
        clickX <= sx1 + sw + 4 &&
        clickY >= sy1 - badgeH &&
        clickY <= sy1 + sh + 4
      ) {
        return t;
      }
    }
    return null;
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const track = getTrackAtCoords(e.clientX, e.clientY);
    if (track) {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      setSelectedTrack(track);
      setCustomIdInput(customVehicleIds[track.track_id] || '');
    } else {
      togglePlayPause();
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const track = getTrackAtCoords(e.clientX, e.clientY);
    setHoveredTrackId(track ? track.track_id : null);
  };

  const handleSaveCustomId = () => {
    if (!selectedTrack) return;
    const trimmed = customIdInput.trim();
    if (trimmed) {
      setCustomVehicleIds(prev => ({
        ...prev,
        [selectedTrack.track_id]: trimmed
      }));
    } else {
      setCustomVehicleIds(prev => {
        const next = { ...prev };
        delete next[selectedTrack.track_id];
        return next;
      });
    }
    setSelectedTrack(null);
  };

  const handleResetCustomId = () => {
    if (!selectedTrack) return;
    setCustomVehicleIds(prev => {
      const next = { ...prev };
      delete next[selectedTrack.track_id];
      return next;
    });
    setSelectedTrack(null);
  };

  return (
    <div className="space-y-4">
      {/* Video Container with Overlaid Transparent Canvas */}
      <div 
        ref={containerRef}
        className="relative w-full aspect-video bg-[#050a12] rounded-2xl overflow-hidden border border-[#192c43] shadow-2xl group"
      >
        <video
          ref={videoRef}
          src={resolvedVideoUrl}
          playsInline
          crossOrigin="anonymous"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            if (onVideoEnded) onVideoEnded();
          }}
          onTimeUpdate={() => {
            const video = videoRef.current;
            if (video && isAnalyzing && onSyncTime) {
              const curTime = video.currentTime;
              if (Math.abs(curTime - lastSyncRef.current) >= 0.25) {
                lastSyncRef.current = curTime;
                onSyncTime(curTime);
              }
            }
          }}
          onSeeking={() => {
            const video = videoRef.current;
            if (video && onSeek) {
              onSeek(video.currentTime);
              lastSyncRef.current = video.currentTime;
            }
          }}
          className="w-full h-full object-contain"
        />

        {/* Dynamic Canvas Bounding Box Overlay with Interactive Pointer Click/Hover */}
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={() => setHoveredTrackId(null)}
          style={{ cursor: hoveredTrackId !== null ? 'pointer' : 'default' }}
          className="absolute inset-0 pointer-events-auto w-full h-full z-10"
        />

        {/* Top-Right Helper Hint Pill */}
        <div className="absolute top-4 right-4 z-20 hidden md:flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-[#0a111a]/80 backdrop-blur border border-[#192c43] text-slate-300 font-mono text-[10px]">
          <Tag className="w-3.5 h-3.5 text-orange-400" />
          <span>Click any vehicle to assign ID</span>
        </div>

        {/* Top Floating Status Pill */}
        <div className="absolute top-4 left-4 z-20 flex items-center space-x-2">
          {isAnalyzing ? (
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-orange-500/90 text-white font-mono text-[11px] font-bold shadow-lg animate-pulse">
              <span className="w-2 h-2 rounded-full bg-white animate-ping" />
              <span>LIVE AI ANALYSIS ACTIVE ●</span>
            </div>
          ) : isCompleted ? (
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-emerald-500/90 text-white font-mono text-[11px] font-bold shadow-lg">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>ANALYSIS COMPLETE ✓</span>
            </div>
          ) : (
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-[#0a111a]/80 backdrop-blur border border-[#192c43] text-slate-300 font-mono text-[11px] font-medium">
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span>TRAFFIC CAMERA FEED READY</span>
            </div>
          )}
        </div>

        {/* Video Controls Bar Overlay */}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-[#050a12] via-[#050a12]/80 to-transparent p-4 flex items-center justify-between z-20 opacity-90 group-hover:opacity-100 transition">
          <div className="flex items-center space-x-3">
            {!isAnalyzing ? (
              <button
                onClick={onStartLiveAnalysis}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 text-white font-extrabold text-xs uppercase tracking-wider shadow-lg shadow-orange-500/30 flex items-center space-x-2 transition"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>START LIVE ANALYSIS</span>
              </button>
            ) : (
              <button
                onClick={togglePlayPause}
                className="px-4 py-2 rounded-xl bg-[#122238] hover:bg-[#1a2e48] border border-[#192c43] text-slate-200 font-bold text-xs flex items-center space-x-2 transition"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-4 h-4 text-orange-400 fill-current" />
                    <span>PAUSE</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 text-emerald-400 fill-current" />
                    <span>RESUME</span>
                  </>
                )}
              </button>
            )}

            {isAnalyzing && (
              <button
                onClick={onStopAnalysis}
                className="px-3.5 py-2 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-400 font-bold text-xs flex items-center space-x-1.5 transition"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>STOP</span>
              </button>
            )}
          </div>
        </div>

        {/* Interactive "Assign Vehicle ID" Modal Dialog */}
        {selectedTrack && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-in fade-in duration-150">
            <div className="bg-[#0b1320] border border-[#1e3450] rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-5 text-left">
              <div className="flex items-center justify-between border-b border-[#192c43] pb-3">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-orange-500/20 border border-orange-500/30 flex items-center justify-center text-orange-400">
                    <Tag className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-100 font-mono">Assign Vehicle ID</h3>
                    <p className="text-[11px] text-slate-400 font-mono">
                      Track #{selectedTrack.track_id} • {(selectedTrack.class_name || 'Vehicle').toUpperCase()}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTrack(null)}
                  className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-slate-300 text-xs font-mono mb-1.5 font-bold">
                    Custom Vehicle ID / License Tag:
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={customIdInput}
                    onChange={(e) => setCustomIdInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveCustomId();
                      else if (e.key === 'Escape') setSelectedTrack(null);
                    }}
                    placeholder="e.g. TAXI-01, TRUCK-A, KA-01-1234"
                    className="w-full bg-[#060b13] border border-[#1e3450] rounded-xl px-4 py-2.5 text-sm font-mono text-white outline-none focus:border-orange-500 transition shadow-inner"
                  />
                </div>

                {/* Quick Presets */}
                <div>
                  <span className="text-[10px] text-slate-400 font-mono block mb-1.5 uppercase">Quick Presets:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {['TAXI-01', 'DELIVERY', 'BUS-EXPRESS', 'TRUCK-01', 'VIP-01', 'AMBULANCE'].map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => setCustomIdInput(tag)}
                        className="text-[10px] font-mono px-2.5 py-1 rounded-md bg-[#122033] hover:bg-orange-500/20 text-slate-300 hover:text-orange-400 border border-[#192c43] hover:border-orange-500/40 transition"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Vehicle Telemetry Snapshot */}
                <div className="grid grid-cols-3 gap-2 bg-[#060b13] p-2.5 rounded-xl border border-[#192c43]/60 text-center font-mono">
                  <div>
                    <span className="text-[9px] text-slate-500 block">Current ID</span>
                    <span className="text-xs font-bold text-cyan-400">
                      {customVehicleIds[selectedTrack.track_id] || `#${selectedTrack.track_id}`}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-500 block">Class</span>
                    <span className="text-xs font-bold text-slate-200 capitalize">
                      {selectedTrack.class_name}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-500 block">Speed</span>
                    <span className="text-xs font-bold text-slate-200">
                      {selectedTrack.speed_kmh ? `${selectedTrack.speed_kmh} km/h` : 'Tracking'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[#192c43]">
                {customVehicleIds[selectedTrack.track_id] ? (
                  <button
                    type="button"
                    onClick={handleResetCustomId}
                    className="text-xs text-red-400 hover:text-red-300 font-mono px-2 py-1 transition"
                  >
                    Reset to Auto ID
                  </button>
                ) : (
                  <div />
                )}
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setSelectedTrack(null)}
                    className="px-4 py-2 rounded-xl bg-[#122033] hover:bg-[#1a2e48] text-slate-300 text-xs font-mono transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCustomId}
                    className="px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-bold text-xs font-mono shadow-md transition flex items-center space-x-1.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Save ID</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
