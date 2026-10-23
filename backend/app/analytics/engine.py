from typing import List, Dict, Any, Optional, Tuple
from app.tracking.track import Track
from app.analytics.counting import VehicleCounter
from app.analytics.direction import estimate_direction
from app.analytics.lane import LaneDetector
from app.analytics.speed import SpeedEstimator
from app.analytics.density import DensityEstimator
from app.analytics.congestion import CongestionEngine
from app.analytics.violations import ViolationDetector

class AnalyticsEngine:
    """
    Master Analytics Engine coordinating vehicle counting, direction detection,
    lane analysis, speed estimation, density, congestion, and violation detection.
    """
    def __init__(
        self,
        fps: float = 30.0,
        pixels_per_meter: Optional[float] = 15.0,
        expected_direction: str = "EAST",
        counting_line: Optional[List[Tuple[float, float]]] = None,
        lane_polygons: Optional[Dict[str, List[Tuple[float, float]]]] = None,
        restricted_zone: Optional[List[Tuple[float, float]]] = None
    ):
        self.fps = float(fps)
        self.counter = VehicleCounter(line=counting_line or [(0.0, 360.0), (1280.0, 360.0)])
        self.lane_detector = LaneDetector(lane_polygons=lane_polygons)
        self.speed_estimator = SpeedEstimator(pixels_per_meter=pixels_per_meter, fps=fps)
        self.density_estimator = DensityEstimator()
        self.congestion_engine = CongestionEngine()
        self.violation_detector = ViolationDetector(expected_direction=expected_direction, restricted_zone=restricted_zone)

        self.time_series_metrics: List[Dict[str, Any]] = []
        self.all_events: List[Dict[str, Any]] = []
        self.last_congestion_status: str = "NORMAL"
        self.congestion_alert_active = False

    def process_frame(
        self,
        active_tracks: List[Track],
        frame_idx: int,
        total_frames: int,
        frame_size: Optional[Tuple[int, int]] = None
    ) -> Dict[str, Any]:
        """
        Process single frame telemetry for all active tracks and update aggregate metrics.
        """
        # 1. Update direction & lane & speed for active tracks
        for track in active_tracks:
            estimate_direction(track)
            self.lane_detector.assign_lane(track)
            self.speed_estimator.estimate_speed(track)

        # 2. Virtual line counting
        self.counter.process_tracks(active_tracks)

        # 3. Density and Congestion
        density_data = self.density_estimator.calculate_density(active_tracks, frame_size)
        congestion_data = self.congestion_engine.evaluate(density_data, active_tracks)
        self.last_congestion_status = str(congestion_data["level"])

        # 4. Violation events
        seconds = frame_idx / self.fps if self.fps > 0 else 0
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        timestamp_str = f"{mins:02d}:{secs:02d}"

        new_events = self.violation_detector.process_frame_violations(active_tracks, frame_idx, timestamp_str)
        if congestion_data["is_alert"] and not self.congestion_alert_active:
            new_events.append({
                "event_type": "CONGESTION",
                "severity": "MEDIUM",
                "track_id": None,
                "class_name": "TRAFFIC",
                "frame_idx": int(frame_idx),
                "timestamp": timestamp_str,
                "message": f"Heavy traffic congestion detected ({density_data['occupancy_percentage']}% occupancy, {density_data['vehicle_count']} active vehicles)",
                "lane": "All Lanes"
            })
            self.congestion_alert_active = bool(congestion_data["is_alert"])

        self.all_events.extend(new_events)

        # 5. Record time series metric snapshot every N frames
        if frame_idx % 15 == 0 or frame_idx == total_frames - 1:
            speeds = [float(t.speed) for t in active_tracks if t.speed is not None]
            avg_speed = sum(speeds) / len(speeds) if speeds else None

            self.time_series_metrics.append({
                "frame": int(frame_idx),
                "timestamp": str(timestamp_str),
                "active_vehicles": int(len(active_tracks)),
                "total_counted": int(self.counter.total_count),
                "average_speed_kmh": round(float(avg_speed), 1) if avg_speed is not None else None,
                "occupancy_percentage": float(density_data["occupancy_percentage"]),
                "density_status": str(density_data["status"]),
                "congestion_level": str(congestion_data["level"])
            })

        return {
            "active_vehicle_count": int(len(active_tracks)),
            "total_counted": int(self.counter.total_count),
            "density": density_data,
            "congestion": congestion_data,
            "lane_counts": self.lane_detector.get_lane_counts(active_tracks),
            "events_this_frame": new_events
        }

    def get_final_summary(self, video_metadata: Dict[str, Any], all_tracked_vehicles: List[Track]) -> Dict[str, Any]:
        """Compiles complete session analytics report."""
        class_summary = {str(k): int(v) for k, v in self.counter.class_counts.items()}
        
        # Calculate speeds
        all_speeds = [float(t.speed) for t in all_tracked_vehicles if t.speed is not None]
        avg_speed = sum(all_speeds) / len(all_speeds) if all_speeds else None

        # Lane breakdown
        lane_counts: Dict[str, int] = {}
        for t in all_tracked_vehicles:
            l = str(t.lane or "Unassigned")
            lane_counts[l] = lane_counts.get(l, 0) + 1

        # Direction breakdown
        dir_counts: Dict[str, int] = {}
        for t in all_tracked_vehicles:
            d = str(t.direction)
            dir_counts[d] = dir_counts.get(d, 0) + 1

        dir_counts_summary = {str(k): int(v) for k, v in self.counter.direction_counts.items()}

        return {
            "video_metadata": video_metadata,
            "summary": {
                "total_vehicles": int(max(self.counter.total_count, len(all_tracked_vehicles))),
                "class_counts": class_summary,
                "direction_counts": dir_counts_summary,
                "lane_distribution": lane_counts,
                "direction_distribution": dir_counts,
                "average_speed_kmh": round(float(avg_speed), 1) if avg_speed is not None else None,
                "speed_calibrated": bool(self.speed_estimator.pixels_per_meter is not None),
                "final_congestion": str(self.last_congestion_status),
                "total_events": int(len(self.all_events))
            },
            "time_series": self.time_series_metrics,
            "events": self.all_events
        }
