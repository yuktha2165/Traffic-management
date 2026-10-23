import pytest
from app.tracking.track import Track
from app.analytics.counting import VehicleCounter
from app.analytics.direction import estimate_direction
from app.analytics.speed import SpeedEstimator
from app.analytics.density import DensityEstimator
from app.analytics.congestion import CongestionEngine
from app.analytics.violations import ViolationDetector

def test_vehicle_counter():
    line = [(100.0, 0.0), (100.0, 500.0)] # Vertical line at x = 100
    counter = VehicleCounter(line=line)

    track = Track(class_name="car", bbox=[80.0, 10.0, 95.0, 30.0], confidence=0.9, frame_idx=0)
    track.trajectory.append((87.5, 20.0, 0))
    track.trajectory.append((115.0, 20.0, 1)) # Crossed line x = 100

    counter.process_tracks([track])
    assert counter.total_count == 1
    assert counter.class_counts["car"] == 1

def test_direction_estimation():
    track = Track(class_name="truck", bbox=[10.0, 10.0, 50.0, 50.0], confidence=0.9, frame_idx=0)
    track.trajectory.clear()
    track.trajectory.append((10.0, 100.0, 0))
    track.trajectory.append((50.0, 100.0, 2))
    track.trajectory.append((100.0, 100.0, 5)) # Moving EAST

    direction = estimate_direction(track)
    assert direction == "EAST"

def test_speed_estimator():
    # Calibrated 10 pixels per meter, 30 fps
    estimator = SpeedEstimator(pixels_per_meter=10.0, fps=30.0)
    track = Track(class_name="car", bbox=[0.0, 0.0, 10.0, 10.0], confidence=0.9, frame_idx=0)
    
    # Simulate movement: 300 pixels in 30 frames (1 sec) -> 30 meters/sec = 108 km/h
    for f in range(10):
        track.trajectory.append((f * 30.0, 10.0, f * 3))

    speed = estimator.estimate_speed(track)
    assert speed is not None
    assert 90.0 < speed < 120.0

def test_speed_estimator_uncalibrated():
    estimator = SpeedEstimator(pixels_per_meter=None, fps=30.0)
    track = Track(class_name="car", bbox=[0.0, 0.0, 10.0, 10.0], confidence=0.9, frame_idx=0)
    track.trajectory.append((0.0, 0.0, 0))
    track.trajectory.append((100.0, 0.0, 10))

    speed = estimator.estimate_speed(track)
    assert speed is None

def test_density_and_congestion():
    density_est = DensityEstimator(roi_area=10000.0)
    
    tracks = [
        Track(class_name="car", bbox=[0.0, 0.0, 50.0, 50.0], confidence=0.9, frame_idx=0)
        for _ in range(15)
    ]
    
    density = density_est.calculate_density(tracks)
    assert density["status"] in ["MEDIUM", "HIGH"]

    congestion_engine = CongestionEngine()
    result = congestion_engine.evaluate(density, tracks)
    assert result["level"] in ["MODERATE", "HEAVY"]


def test_congestion_alert_requires_multiple_vehicles():
    engine = CongestionEngine()
    single_vehicle = [
        Track(class_name="car", bbox=[0.0, 0.0, 768.0, 432.0], confidence=0.9, frame_idx=0)
    ]

    result = engine.evaluate(
        {"vehicle_count": 1, "occupancy_percentage": 100.0},
        single_vehicle
    )

    assert result["level"] == "NORMAL"
    assert result["is_alert"] is False


def test_density_ignores_frame_filling_false_positive_box():
    estimator = DensityEstimator()
    track = Track(
        class_name="car",
        bbox=[-1.0, 0.0, 769.0, 432.0],
        confidence=0.9,
        frame_idx=0
    )

    result = estimator.calculate_density([track], frame_size=(768, 432))

    assert result["occupancy_percentage"] == 0.0
    assert result["status"] == "LOW"


def test_diagonal_motion_does_not_trigger_cardinal_wrong_way_alert():
    detector = ViolationDetector(expected_direction="EAST")
    track = Track(class_name="car", bbox=[0.0, 0.0, 20.0, 20.0], confidence=0.9, frame_idx=0)
    track.direction = "NORTH_WEST"
    for frame_idx in range(5):
        track.trajectory.append((float(frame_idx), 0.0, frame_idx))

    events = [
        detector.process_frame_violations([track], frame_idx, "00:00")
        for frame_idx in range(5)
    ]

    assert not any(event["event_type"] == "WRONG_WAY" for frame_events in events for event in frame_events)


def test_opposite_direction_alert_requires_sustained_motion():
    detector = ViolationDetector(expected_direction="EAST")
    track = Track(class_name="car", bbox=[0.0, 0.0, 20.0, 20.0], confidence=0.9, frame_idx=0)
    track.direction = "WEST"
    for frame_idx in range(5):
        track.trajectory.append((float(frame_idx), 0.0, frame_idx))

    events = [
        detector.process_frame_violations([track], frame_idx, "00:00")
        for frame_idx in range(5)
    ]

    assert sum(event["event_type"] == "WRONG_WAY" for frame_events in events for event in frame_events) == 1
