from typing import List, Dict, Any, Optional, Tuple
from app.tracking.track import Track

class DensityEstimator:
    """
    Traffic density calculator.
    Estimates road area occupancy percentage and classifies traffic density into LOW, MEDIUM, or HIGH.
    """
    def __init__(self, roi_area: float = 1280 * 720, low_thresh: float = 0.12, high_thresh: float = 0.28):
        self.roi_area = roi_area if roi_area > 0 else 1280 * 720
        self.low_thresh = low_thresh
        self.high_thresh = high_thresh

    def calculate_density(
        self,
        active_tracks: List[Track],
        frame_size: Optional[Tuple[int, int]] = None
    ) -> Dict[str, Any]:
        """
        Calculates occupancy ratio and returns density stats.
        """
        roi_area = self.roi_area
        frame_width = frame_height = None
        if frame_size and frame_size[0] > 0 and frame_size[1] > 0:
            frame_width, frame_height = frame_size
            roi_area = float(frame_width * frame_height)

        total_bbox_area = 0.0
        for track in active_tracks:
            x1, y1, x2, y2 = track.bbox
            if frame_width is not None and frame_height is not None:
                x1 = max(0.0, min(float(frame_width), x1))
                x2 = max(0.0, min(float(frame_width), x2))
                y1 = max(0.0, min(float(frame_height), y1))
                y2 = max(0.0, min(float(frame_height), y2))
            w = max(0.0, x2 - x1)
            h = max(0.0, y2 - y1)
            box_area = w * h
            # A single vehicle box covering most of the image is almost always
            # a detector false positive, not road occupancy.
            if box_area <= roi_area * 0.25:
                total_bbox_area += box_area

        occupancy = min(1.0, total_bbox_area / roi_area)

        if occupancy < self.low_thresh:
            status = "LOW"
        elif occupancy < self.high_thresh:
            status = "MEDIUM"
        else:
            status = "HIGH"

        return {
            "vehicle_count": len(active_tracks),
            "occupancy_percentage": round(occupancy * 100, 1),
            "status": status
        }
