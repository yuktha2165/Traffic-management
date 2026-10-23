import base64
import cv2
import numpy as np
import logging
from typing import Dict, Any, Optional
from app.tracking.tracker import MultiObjectTracker
from app.tracking.track import Track
from app.analytics.speed import estimate_speed_kmh, assign_lane_and_direction

from app.config import settings

logger = logging.getLogger("traffic_app")

class LiveStreamProcessor:
    def __init__(self, pixels_per_meter: float = 15.0, fps: float = 30.0, frame_skip: int = settings.FRAME_SKIP):
        from app.detection.rtdetr_detector import RTDETRDetector

        self.detector = RTDETRDetector()
        self.tracker = MultiObjectTracker()
        self.pixels_per_meter = pixels_per_meter
        self.fps = fps
        self.frame_skip = max(1, frame_skip)
        self.frame_count = 0
        self.rtsp_cap: Optional[cv2.VideoCapture] = None
        self.current_rtsp_url: Optional[str] = None

    def process_frame_ndarray(self, frame: np.ndarray) -> Dict[str, Any]:
        """Process an OpenCV BGR image array through YOLO + Kalman Filter."""
        self.frame_count += 1
        height, width = frame.shape[:2]

        if self.frame_count % self.frame_skip == 0 or self.frame_count == 1:
            detections = self.detector.detect(frame)
            active_tracks = self.tracker.update(detections, self.frame_count)
        else:
            active_tracks = self.tracker.propagate_skipped_frame(self.frame_count)


        tracks_payload = []
        speeds = []

        for t in active_tracks:
            speed_kmh = estimate_speed_kmh(
                t.trajectory, 
                fps=self.fps, 
                pixels_per_meter=self.pixels_per_meter
            )
            lane_info = assign_lane_and_direction(
                t.centroid, 
                t.trajectory, 
                frame_width=width, 
                frame_height=height
            )

            if speed_kmh is not None and speed_kmh > 0:
                speeds.append(speed_kmh)

            tracks_payload.append({
                "track_id": t.track_id,
                "class_name": t.class_name,
                "bbox": [round(v, 1) for v in t.bbox],
                "centroid": [round(t.centroid[0], 1), round(t.centroid[1], 1)],
                "confidence": round(t.confidence, 2),
                "speed_kmh": round(speed_kmh, 1) if speed_kmh is not None else None,
                "lane": lane_info["lane"],
                "direction": lane_info["direction"]
            })

        avg_speed = round(float(np.mean(speeds)), 1) if len(speeds) > 0 else None

        return {
            "frame_idx": self.frame_count,
            "active_vehicles": len(tracks_payload),
            "average_speed": avg_speed,
            "tracks": tracks_payload
        }

    def process_base64_frame(self, base64_str: str) -> Dict[str, Any]:
        """Decode incoming base64 image string, run detection + tracking, return telemetry."""
        try:
            if "," in base64_str:
                base64_str = base64_str.split(",")[1]

            img_bytes = base64.b64decode(base64_str)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is None:
                return {"error": "Failed to decode frame image"}

            return self.process_frame_ndarray(frame)

        except Exception as e:
            logger.error(f"Error processing live base64 frame: {e}")
            return {"error": str(e), "frame_idx": self.frame_count}

    def process_rtsp_stream_frame(self, rtsp_url: str) -> Dict[str, Any]:
        """Read latest frame from live RTSP/HTTP traffic camera stream and process telemetry."""
        try:
            if self.current_rtsp_url != rtsp_url or self.rtsp_cap is None or not self.rtsp_cap.isOpened():
                if self.rtsp_cap is not None:
                    self.rtsp_cap.release()
                logger.info(f"Connecting to RTSP/IP Camera stream: {rtsp_url}")
                self.rtsp_cap = cv2.VideoCapture(rtsp_url)
                self.current_rtsp_url = rtsp_url

            if not self.rtsp_cap.isOpened():
                return {"error": f"Failed to connect to IP Camera stream at {rtsp_url}"}

            ret, frame = self.rtsp_cap.read()
            if not ret or frame is None:
                self.rtsp_cap.release()
                self.rtsp_cap = None
                return {"error": "Stream frame read timeout or stream ended"}

            return self.process_frame_ndarray(frame)

        except Exception as e:
            logger.error(f"Error reading RTSP stream {rtsp_url}: {e}")
            return {"error": str(e), "frame_idx": self.frame_count}

    def close(self):
        """Release active camera captures."""
        if self.rtsp_cap is not None:
            self.rtsp_cap.release()
            self.rtsp_cap = None

class VideoFileLiveAnalyzer:
    """
    Concurrent Live Video Analyzer:
    Processes an uploaded MP4 video in sync with video playback time,
    streaming YOLO + Kalman Filter + Hungarian Association telemetry over WebSocket.
    """
    def __init__(
        self,
        video_path: str,
        confidence_threshold: float = settings.CONFIDENCE_THRESHOLD,
        detection_interval: int = settings.DETECTION_INTERVAL,
        pixels_per_meter: Optional[float] = settings.PIXELS_PER_METER,
        expected_direction: str = settings.EXPECTED_DIRECTION
    ):
        self.video_path = video_path
        self.confidence_threshold = confidence_threshold
        self.detection_interval = max(1, detection_interval)
        self.pixels_per_meter = pixels_per_meter
        self.expected_direction = expected_direction

        self.cap = cv2.VideoCapture(video_path)
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720

        from app.analytics.engine import AnalyticsEngine
        from app.detection.rtdetr_detector import RTDETRDetector

        self.detector = RTDETRDetector(confidence_threshold=confidence_threshold)
        self.tracker = MultiObjectTracker(confidence_threshold=confidence_threshold)
        self.analytics_engine = AnalyticsEngine(
            fps=self.fps,
            pixels_per_meter=pixels_per_meter,
            expected_direction=expected_direction
        )
        self.analytics_engine.lane_detector.set_default_lanes_for_resolution(self.width, self.height)
        Track.reset_id_counter()
        self.frame_idx = 0
        self.all_tracked_vehicles: Dict[int, Any] = {}

    def seek_time(self, timestamp_secs: float):
        """Reset tracking upon video seek."""
        target_frame = max(0, min(self.total_frames - 1, int(timestamp_secs * self.fps)))
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
        self.frame_idx = target_frame
        if target_frame <= 2:
            Track.reset_id_counter()
        self.tracker = MultiObjectTracker(confidence_threshold=self.confidence_threshold)
        self.all_tracked_vehicles.clear()

    def sync_time(self, timestamp_secs: float):
        """Soft sync internal video capture to match client playback timestamp."""
        target_frame = max(0, min(self.total_frames - 1, int(timestamp_secs * self.fps)))
        # Only seek if drift between backend frame and video player exceeds 4 frames (~133ms)
        if abs(self.frame_idx - target_frame) > 4:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
            self.frame_idx = target_frame

    def step_next_frame(self) -> Optional[Dict[str, Any]]:
        """Reads next video frame, runs detection/Kalman step, returns rich live telemetry."""
        if not self.cap.isOpened():
            return None

        ret, frame = self.cap.read()
        if not ret or frame is None:
            return None

        current_idx = self.frame_idx
        self.frame_idx += 1

        if current_idx % self.detection_interval == 0 or current_idx == 0:
            dets = self.detector.detect(frame, confidence=self.confidence_threshold)
            active_tracks = self.tracker.update(dets, current_idx)
        else:
            active_tracks = self.tracker.propagate_skipped_frame(current_idx)

        for t in active_tracks:
            self.all_tracked_vehicles[t.track_id] = t

        telemetry = self.analytics_engine.process_frame(
            active_tracks,
            current_idx,
            self.total_frames,
            frame_size=(self.width, self.height)
        )

        tracks_payload = []
        for t in active_tracks:
            traj_list = list(t.trajectory)
            speed_kmh = estimate_speed_kmh(traj_list, fps=self.fps, pixels_per_meter=self.pixels_per_meter)
            lane_info = assign_lane_and_direction(t.centroid, traj_list, self.width, self.height)
            
            # Format trajectory: latest 15 points
            formatted_traj = [[round(p[0], 1), round(p[1], 1)] for p in traj_list[-15:]]

            tracks_payload.append({
                "track_id": t.track_id,
                "class_name": t.class_name,
                "bbox": [round(v, 1) for v in t.bbox],
                "centroid": [round(t.centroid[0], 1), round(t.centroid[1], 1)],
                "confidence": round(t.confidence, 2),
                "speed_kmh": round(speed_kmh, 1) if speed_kmh is not None else None,
                "lane": t.lane or lane_info["lane"],
                "direction": t.direction or lane_info["direction"],
                "trajectory": formatted_traj,
                "status": t.status
            })

        class_counts: Dict[str, int] = {"car": 0, "bus": 0, "truck": 0, "motorcycle": 0}
        direction_counts: Dict[str, int] = {}
        speeds = []

        for t in self.all_tracked_vehicles.values():
            c_name = (t.class_name or "car").lower()
            if c_name in ["van", "pickup", "lorry"]:
                c_name = "truck"
            elif c_name in ["coach", "minibus"]:
                c_name = "bus"
            elif c_name in ["motorbike", "scooter"]:
                c_name = "motorcycle"
            elif c_name in ["bike", "cyclist"]:
                c_name = "bicycle"

            class_counts[c_name] = class_counts.get(c_name, 0) + 1
            d_name = t.direction or "EAST"
            direction_counts[d_name] = direction_counts.get(d_name, 0) + 1

        for tp in tracks_payload:
            if tp.get("speed_kmh") is not None and tp["speed_kmh"] > 0:
                speeds.append(tp["speed_kmh"])

        avg_speed = round(float(np.mean(speeds)), 1) if speeds else None
        timestamp = round(current_idx / self.fps, 2)

        return {
            "type": "telemetry",
            "timestamp": timestamp,
            "frame_idx": current_idx,
            "total_frames": self.total_frames,
            "video_width": self.width,
            "video_height": self.height,
            "fps": round(self.fps, 1),
            "active_vehicles": len(tracks_payload),
            "total_vehicles": len(self.all_tracked_vehicles),
            "tracks": tracks_payload,
            "class_counts": class_counts,
            "lane_counts": telemetry.get("lane_counts", {}),
            "direction_counts": direction_counts,
            "average_speed": avg_speed,
            "density": telemetry["density"]["status"],
            "congestion": telemetry["congestion"]["level"],
            "events": telemetry.get("events_this_frame", []),
            "counting_line": self.analytics_engine.counter.line,
            "lane_polygons": self.analytics_engine.lane_detector.lane_polygons
        }

    def close(self):
        if self.cap is not None:
            self.cap.release()


