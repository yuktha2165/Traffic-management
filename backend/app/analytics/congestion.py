from typing import List, Dict, Any, Optional
from app.tracking.track import Track

class CongestionEngine:
    """
    Evaluates traffic congestion using density, vehicle volume, and average speed.
    Classifies status as NORMAL, MODERATE, or HEAVY.
    """
    def evaluate(self, density_data: Dict[str, Any], active_tracks: List[Track]) -> Dict[str, Any]:
        vehicle_count = density_data.get("vehicle_count", len(active_tracks))
        occupancy = density_data.get("occupancy_percentage", 0.0)

        valid_speeds = [t.speed for t in active_tracks if t.speed is not None]
        avg_speed = sum(valid_speeds) / len(valid_speeds) if valid_speeds else None

        # Large or spurious boxes can inflate occupancy, so require a meaningful
        # number of simultaneous vehicles before classifying traffic congestion.
        if vehicle_count >= 8 and (
            occupancy >= 30.0 or (avg_speed is not None and avg_speed < 18.0)
        ):
            congestion_level = "HEAVY"
            alert = True
        elif vehicle_count >= 5 and (
            occupancy >= 18.0 or (avg_speed is not None and avg_speed < 30.0)
        ):
            congestion_level = "MODERATE"
            alert = False
        else:
            congestion_level = "NORMAL"
            alert = False

        return {
            "level": congestion_level,
            "vehicle_count": vehicle_count,
            "occupancy_percentage": occupancy,
            "average_speed_kmh": round(avg_speed, 1) if avg_speed is not None else None,
            "is_alert": alert
        }
