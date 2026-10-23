import axios from 'axios';
import { AnalysisSessionSummary, EventAlert, ProcessingJob, SessionAnalytics, VehicleTrack, VideoMetadata } from '../types';

const API_BASE = '/api';

export const api = {
  async uploadVideo(file: File): Promise<{ success: boolean; video_id: string; metadata: VideoMetadata }> {
    const formData = new FormData();
    formData.append('file', file);
    // Let the browser/Axios add the multipart boundary to Content-Type.
    const res = await axios.post(`${API_BASE}/videos/upload`, formData);
    return res.data;
  },

  async startAnalysis(
    videoId: string,
    params: {
      confidence_threshold?: number;
      max_missed_frames?: number;
      pixels_per_meter?: number | null;
      expected_direction?: string;
      detection_interval?: number;
    }
  ): Promise<{ success: boolean; job_id: string; status: string }> {
    const formData = new FormData();
    if (params.confidence_threshold !== undefined) formData.append('confidence_threshold', params.confidence_threshold.toString());
    if (params.max_missed_frames !== undefined) formData.append('max_missed_frames', params.max_missed_frames.toString());
    if (params.pixels_per_meter !== undefined && params.pixels_per_meter !== null) {
      formData.append('pixels_per_meter', params.pixels_per_meter.toString());
    }
    if (params.expected_direction) formData.append('expected_direction', params.expected_direction);
    if (params.detection_interval !== undefined) formData.append('detection_interval', params.detection_interval.toString());

    const res = await axios.post(`${API_BASE}/videos/${videoId}/analyze`, formData);
    return res.data;
  },

  async getJobStatus(videoId: string): Promise<{ success: boolean; job: ProcessingJob }> {
    const res = await axios.get(`${API_BASE}/videos/${videoId}/status`);
    return res.data;
  },

  async getAnalytics(videoId: string): Promise<{ success: boolean; analytics: SessionAnalytics }> {
    const res = await axios.get(`${API_BASE}/videos/${videoId}/analytics`);
    return res.data;
  },

  async getVehicles(videoId: string): Promise<{ success: boolean; vehicles: VehicleTrack[]; total: number }> {
    const res = await axios.get(`${API_BASE}/videos/${videoId}/vehicles`);
    return res.data;
  },

  async getEvents(videoId: string): Promise<{ success: boolean; events: EventAlert[]; total: number }> {
    const res = await axios.get(`${API_BASE}/videos/${videoId}/events`);
    return res.data;
  },

  async getHistory(): Promise<{ success: boolean; sessions: AnalysisSessionSummary[]; total: number }> {
    const res = await axios.get(`${API_BASE}/history`);
    return res.data;
  },

  async deleteHistory(videoId: string): Promise<{ success: boolean; deleted: boolean }> {
    const res = await axios.delete(`${API_BASE}/history/${videoId}`);
    return res.data;
  },

  async getHealth(): Promise<any> {
    const res = await axios.get(`${API_BASE}/health`);
    return res.data;
  },

  getProcessedVideoUrl(videoId: string): string {
    return `${API_BASE}/videos/${videoId}/processed-video`;
  },

  async generateProcessedVideo(videoId: string): Promise<{ success: boolean; message: string }> {
    const res = await axios.post(`${API_BASE}/videos/${videoId}/generate-processed-video`);
    return res.data;
  },


  connectWebSocket(videoId: string, onMessage: (data: ProcessingJob) => void): () => void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${API_BASE}/videos/${videoId}/ws`;
    
    let ws: WebSocket | null = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type !== 'ping') {
          onMessage(data);
        }
      } catch (err) {
        console.error('WebSocket parse error:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('WebSocket error:', err);
    };

    return () => {
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  },

  connectLiveStreamWebSocket(onTelemetryMessage: (data: any) => void): { 
    sendFrame: (b64: string) => void; 
    sendRtspUrl: (url: string) => void; 
    close: () => void 
  } {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${API_BASE}/live-stream/ws`;
    
    let ws: WebSocket | null = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onTelemetryMessage(data);
      } catch (err) {
        console.error('LiveStream WebSocket parse error:', err);
      }
    };

    return {
      sendFrame: (base64Image: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ frame: base64Image }));
        }
      },
      sendRtspUrl: (rtspUrl: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ rtsp_url: rtspUrl }));
        }
      },
      close: () => {
        if (ws) {
          ws.close();
          ws = null;
        }
      }
    };
  },
  getVideoFileUrl(videoId: string): string {
    return `${API_BASE}/videos/${videoId}/video-file`;
  },

  connectLiveAnalysisWS(videoId: string, onMessage: (data: any) => void): {
    sendCommand: (cmd: any) => void;
    close: () => void;
  } {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${API_BASE}/videos/${videoId}/live-analysis/ws`;

    let ws: WebSocket | null = new WebSocket(wsUrl);
    const pendingCommands: any[] = [];
    let intentionallyClosed = false;

    ws.onopen = () => {
      while (ws && ws.readyState === WebSocket.OPEN && pendingCommands.length > 0) {
        ws.send(JSON.stringify(pendingCommands.shift()));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch (err) {
        console.error('Live Analysis WS parse error:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('Live Analysis WS error:', err);
      onMessage({ error: 'Live analysis connection failed. Confirm the backend is running, then retry.' });
    };

    ws.onclose = (event) => {
      if (!intentionallyClosed && event.code !== 1000) {
        onMessage({ error: 'Live analysis connection closed unexpectedly. Please retry.' });
      }
    };

    return {
      sendCommand: (cmd: any) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(cmd));
        } else if (ws && ws.readyState === WebSocket.CONNECTING) {
          pendingCommands.push(cmd);
        }
      },
      close: () => {
        if (ws) {
          intentionallyClosed = true;
          pendingCommands.length = 0;
          ws.close();
          ws = null;
        }
      }
    };
  }
};


