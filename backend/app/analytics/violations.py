import cv2
import numpy as np
from typing import List, Dict, Any, Tuple, Optional, Set
from app.tracking.track import Track

OPPOSITE_DIRECTIONS = {
    "EAST": ["WEST"],
    "WEST": ["EAST"],
    "NORTH": ["SOUTH"],
    "SOUTH": ["NORTH"],
    "NORTH_EAST": ["SOUTH_WEST"],
    "SOUTH_WEST": ["NORTH_EAST"],
    "NORTH_WEST": ["SOUTH_EAST"],
    "SOUTH_EAST": ["NORTH_WEST"]
}

class ViolationDetector:
    """
    Detects traffic violations and security alerts:
    - Wrong-Way movement detection
    - Restricted Zone Entry violation detection
    """
    def __init__(
        self,
        expected_direction: str = "EAST",
        restricted_zone: Optional[List[Tuple[float, float]]] = None
    ):
        self.expected_direction = expected_direction.upper()
        self.restricted_zone = restricted_zone or []
        self.reported_wrong_way: Set[int] = set()
        self.reported_zone_violations: Set[int] = set()
        self.wrong_way_streaks: Dict[int, int] = {}

    def process_frame_violations(self, active_tracks: List[Track], frame_idx: int, timestamp_str: str) -> List[Dict[str, Any]]:
        events = []

        opp_dirs = OPPOSITE_DIRECTIONS.get(self.expected_direction, [])

        for track in active_tracks:
            # 1. Check Wrong-Way Movement
            if track.track_id not in self.reported_wrong_way:
                if len(track.trajectory) >= 5 and track.direction in opp_dirs:
                    self.wrong_way_streaks[track.track_id] = self.wrong_way_streaks.get(track.track_id, 0) + 1
                else:
                    self.wrong_way_streaks.pop(track.track_id, None)

                if self.wrong_way_streaks.get(track.track_id, 0) >= 5:
                    self.reported_wrong_way.add(track.track_id)
                    events.append({
                        "event_type": "WRONG_WAY",
                        "severity": "HIGH",
                        "track_id": track.track_id,
                        "class_name": track.class_name,
                        "frame_idx": frame_idx,
                        "timestamp": timestamp_str,
                        "message": f"Wrong-way vehicle detected (Track ID #{track.track_id} {track.class_name.upper()} moving {track.direction}, expected {self.expected_direction})",
                        "lane": track.lane or "N/A"
                    })

            # 2. Check Restricted Zone Violation
            if self.restricted_zone and track.track_id not in self.reported_zone_violations:
                cx, cy = track.centroid
                np_zone = np.array(self.restricted_zone, dtype=np.int32)
                if cv2.pointPolygonTest(np_zone, (float(cx), float(cy)), False) >= 0:
                    self.reported_zone_violations.add(track.track_id)
                    events.append({
                        "event_type": "ZONE_VIOLATION",
                        "severity": "CRITICAL",
                        "track_id": track.track_id,
                        "class_name": track.class_name,
                        "frame_idx": frame_idx,
                        "timestamp": timestamp_str,
                        "message": f"Restricted zone violation (Track ID #{track.track_id} {track.class_name.upper()} entered restricted region)",
                        "lane": track.lane or "N/A"
                    })

        return events
