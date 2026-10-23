import os
import cv2
import time
import asyncio
import logging
import numpy as np
from typing import Dict, Any, Optional
from datetime import datetime, timezone

from app.config import settings
from app.tracking.tracker import MultiObjectTracker
from app.analytics.engine import AnalyticsEngine
from app.services.video_service import extract_video_metadata, draw_frame_overlays, remux_to_web_mp4
from app.database.db_factory import get_repository

logger = logging.getLogger("traffic_app")

class JobManager:
    """In-memory manager tracking active video processing jobs."""
    def __init__(self):
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.listeners: Dict[str, list] = {}

    def create_job(self, job_id: str, video_path: str, config: Dict[str, Any]) -> Dict[str, Any]:
        job_data = {
            "id": job_id,
            "video_id": job_id,
            "video_path": video_path,
            "status": "QUEUED",  # QUEUED, PROCESSING, COMPLETED, FAILED
            "progress": 0,
            "progress_percent": 0.0,
            "processed_frames": 0,
            "total_frames": 0,
            "vehicles_detected": 0,
            "processing_fps": 0.0,
            "processing_device": "CPU",
            "estimated_remaining_seconds": 0.0,
            "error": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "config": config,
            "summary": None,
            "processed_video_status": "NOT_GENERATED"  # NOT_GENERATED, GENERATING, READY, FAILED
        }
        self.jobs[job_id] = job_data
        return job_data

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        return self.jobs.get(job_id)

    def update_job(self, job_id: str, updates: Dict[str, Any]):
        if job_id in self.jobs:
            self.jobs[job_id].update(updates)
            self.jobs[job_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._notify_listeners(job_id)

    def add_listener(self, job_id: str, callback):
        if job_id not in self.listeners:
            self.listeners[job_id] = []
        self.listeners[job_id].append(callback)

    def remove_listener(self, job_id: str, callback):
        if job_id in self.listeners and callback in self.listeners[job_id]:
            self.listeners[job_id].remove(callback)

    def _notify_listeners(self, job_id: str):
        if job_id in self.listeners:
            job_data = self.jobs[job_id]
            for callback in self.listeners[job_id]:
                try:
                    callback(job_data)
                except Exception as e:
                    logger.error(f"Error in job listener callback: {e}")

job_manager = JobManager()

async def process_video_background_task(
    job_id: str,
    video_path: str,
    output_video_path: str,
    config: Dict[str, Any]
):
    """
    Direct Video Background Analytics Pipeline:
    Optimized OpenCV Video Decoder -> Detection Scheduler (DETECTION_INTERVAL) ->
    Batch YOLO GPU/MPS Inference -> Hungarian Association -> Kalman Filter Update ->
    Persistent Vehicle Tracking & Real-Time Traffic Analytics -> DB Aggregated Write.
    """
    logger.info(f"Starting direct video analysis job: {job_id}")
    job_manager.update_job(job_id, {"status": "PROCESSING"})

    repo = await get_repository()

    try:
        from app.detection.rtdetr_detector import RTDETRDetector

        meta = extract_video_metadata(video_path)
        total_frames = meta["total_frames"]
        fps = meta["fps"]
        width = meta["width"]
        height = meta["height"]

        # Configurable Parameters
        conf_thresh = config.get("confidence_threshold", settings.CONFIDENCE_THRESHOLD)
        yolo_model = config.get("yolo_model", settings.YOLO_MODEL)
        detection_interval = int(config.get("detection_interval", settings.DETECTION_INTERVAL))
        detection_interval = max(1, detection_interval)
        batch_size = int(config.get("batch_size", settings.YOLO_BATCH_SIZE))
        roi = config.get("roi", settings.ROI_CONFIG)

        detector = RTDETRDetector(
            model_name=yolo_model,
            confidence_threshold=conf_thresh,
            imgsz=int(config.get("inference_resolution", settings.INFERENCE_WIDTH))
        )
        device_label = detector.get_device_label()

        max_missed = config.get("max_missed_frames", settings.MAX_MISSED_FRAMES)
        max_dist = config.get("max_association_distance", settings.MAX_ASSOCIATION_DISTANCE)
        tracker = MultiObjectTracker(
            max_missed_frames=max_missed,
            max_distance=max_dist,
            confidence_threshold=conf_thresh
        )

        pixels_per_meter = config.get("pixels_per_meter", settings.PIXELS_PER_METER)
        expected_direction = config.get("expected_direction", settings.EXPECTED_DIRECTION)
        counting_line = config.get("counting_line")
        lane_polygons = config.get("lane_polygons", {})
        restricted_zone = config.get("restricted_zone")

        analytics_engine = AnalyticsEngine(
            fps=fps,
            pixels_per_meter=pixels_per_meter,
            expected_direction=expected_direction,
            counting_line=counting_line,
            lane_polygons=lane_polygons,
            restricted_zone=restricted_zone
        )

        if not lane_polygons:
            analytics_engine.lane_detector.set_default_lanes_for_resolution(width, height)

        job_manager.update_job(job_id, {
            "total_frames": total_frames,
            "processing_device": device_label
        })

        cap = cv2.VideoCapture(video_path)
        frame_idx = 0
        start_time = time.time()
        fps_timer = time.time()
        fps_frame_count = 0
        current_proc_fps = 0.0

        all_tracked_vehicles: Dict[int, Any] = {}

        batch_frames = []
        batch_indices = []

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret or frame is None:
                break

            if frame_idx % detection_interval == 0 or frame_idx == 0:
                batch_frames.append(frame)
                batch_indices.append(frame_idx)
            else:
                # Intermediate frame: propagate Kalman prediction without CNN forward pass
                active_tracks = tracker.propagate_skipped_frame(frame_idx)
                for t in active_tracks:
                    all_tracked_vehicles[t.track_id] = t
                analytics_engine.process_frame(active_tracks, frame_idx, total_frames, frame_size=(width, height))

            frame_idx += 1
            fps_frame_count += 1

            # Run batch inference when batch is full or at end of video
            if len(batch_frames) >= batch_size or (frame_idx >= total_frames and batch_frames):
                batch_detections = detector.detect_batch(batch_frames, roi=roi)
                for f_idx, f_dets in zip(batch_indices, batch_detections):
                    active_tracks = tracker.update(f_dets, f_idx)
                    for t in active_tracks:
                        all_tracked_vehicles[t.track_id] = t
                    analytics_engine.process_frame(active_tracks, f_idx, total_frames, frame_size=(width, height))

                batch_frames.clear()
                batch_indices.clear()

            # Progress Metrics
            if time.time() - fps_timer >= 0.2:
                current_proc_fps = fps_frame_count / (time.time() - fps_timer)
                fps_timer = time.time()
                fps_frame_count = 0

                processed_count = min(frame_idx, total_frames)
                percent = round((processed_count / total_frames) * 100, 1) if total_frames > 0 else 0.0
                elapsed = time.time() - start_time
                avg_proc_fps = processed_count / elapsed if elapsed > 0 else 1.0
                eta_secs = round((total_frames - processed_count) / avg_proc_fps, 1) if avg_proc_fps > 0 else 0.0

                job_manager.update_job(job_id, {
                    "processed_frames": processed_count,
                    "current_frame": processed_count,
                    "progress": int(percent),
                    "progress_percent": min(100.0, percent),
                    "vehicles_detected": len(all_tracked_vehicles),
                    "processing_fps": round(current_proc_fps, 1),
                    "estimated_remaining_seconds": max(0.0, eta_secs)
                })

                await asyncio.sleep(0.0001)

        # Flush any remaining frames
        if batch_frames:
            batch_detections = detector.detect_batch(batch_frames, roi=roi)
            for f_idx, f_dets in zip(batch_indices, batch_detections):
                active_tracks = tracker.update(f_dets, f_idx)
                for t in active_tracks:
                    all_tracked_vehicles[t.track_id] = t
                analytics_engine.process_frame(active_tracks, f_idx, total_frames, frame_size=(width, height))

        cap.release()

        # Finalize Analytics Summary
        speed_calibrated = (pixels_per_meter is not None and pixels_per_meter > 0)
        final_vehicles_list = [t.to_dict() for t in all_tracked_vehicles.values()]
        final_report = analytics_engine.get_final_summary(meta, list(all_tracked_vehicles.values()))

        # Save Aggregated Session to Database
        session_data = {
            "id": job_id,
            "video_name": meta["filename"],
            "video_path": video_path,
            "processed_video_path": None,  # Generated on demand
            "duration": meta["duration"],
            "fps": meta["fps"],
            "resolution": meta["resolution"],
            "total_frames": total_frames,
            "file_size_mb": meta["size_mb"],
            "total_vehicles": final_report["summary"]["total_vehicles"],
            "class_counts": final_report["summary"]["class_counts"],
            "average_speed": final_report["summary"]["average_speed_kmh"],
            "speed_calibrated": speed_calibrated,
            "traffic_density": final_report["summary"].get("traffic_density", "NORMAL"),
            "congestion": final_report["summary"]["final_congestion"],
            "status": "COMPLETED",
            "processing_device": device_label,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "config": config
        }

        await repo.create_session(session_data)
        await repo.save_vehicles(job_id, final_vehicles_list)
        await repo.save_events(job_id, final_report["events"])
        await repo.save_analytics(job_id, final_report)

        job_manager.update_job(job_id, {
            "status": "COMPLETED",
            "progress": 100,
            "progress_percent": 100.0,
            "processed_frames": total_frames,
            "vehicles_detected": final_report["summary"]["total_vehicles"],
            "estimated_remaining_seconds": 0.0,
            "summary": session_data
        })
        logger.info(f"Direct video analysis job {job_id} completed successfully.")

    except Exception as e:
        logger.error(f"Error processing job {job_id}: {e}", exc_info=True)
        job_manager.update_job(job_id, {
            "status": "FAILED",
            "error": str(e)
        })

async def generate_processed_video_background_task(
    job_id: str,
    video_path: str,
    output_video_path: str,
    config: Dict[str, Any]
):
    """
    On-Demand Annotated Video Generator:
    Generates video file containing bounding boxes, vehicle IDs, trajectories, counting line, and alerts.
    """
    logger.info(f"Generating annotated video output for job: {job_id}")
    job_manager.update_job(job_id, {"processed_video_status": "GENERATING"})

    try:
        meta = extract_video_metadata(video_path)
        fps = meta["fps"]
        width = meta["width"]
        height = meta["height"]
        total_frames = meta["total_frames"]

        conf_thresh = config.get("confidence_threshold", settings.CONFIDENCE_THRESHOLD)
        yolo_model = config.get("yolo_model", settings.YOLO_MODEL)
        detector = RTDETRDetector(model_name=yolo_model, confidence_threshold=conf_thresh)
        tracker = MultiObjectTracker(confidence_threshold=conf_thresh)
        
        pixels_per_meter = config.get("pixels_per_meter", settings.PIXELS_PER_METER)
        analytics_engine = AnalyticsEngine(fps=fps, pixels_per_meter=pixels_per_meter)
        analytics_engine.lane_detector.set_default_lanes_for_resolution(width, height)

        temp_output = output_video_path + ".temp.mp4"
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out_writer = cv2.VideoWriter(temp_output, fourcc, fps, (width, height))

        cap = cv2.VideoCapture(video_path)
        frame_idx = 0

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret or frame is None:
                break

            if frame_idx % 2 == 0:
                dets = detector.detect(frame)
                active_tracks = tracker.update(dets, frame_idx)
            else:
                active_tracks = tracker.propagate_skipped_frame(frame_idx)

            telemetry = analytics_engine.process_frame(
                active_tracks,
                frame_idx,
                total_frames,
                frame_size=(width, height)
            )

            overlay = draw_frame_overlays(
                frame=frame,
                active_tracks=active_tracks,
                counting_line=analytics_engine.counter.line,
                lane_polygons=analytics_engine.lane_detector.lane_polygons,
                density_status=telemetry["density"]["status"],
                congestion_level=telemetry["congestion"]["level"],
                total_counted=telemetry["total_counted"],
                current_fps=30.0,
                frame_idx=frame_idx,
                speed_calibrated=(pixels_per_meter is not None and pixels_per_meter > 0)
            )
            out_writer.write(overlay)
            frame_idx += 1

            if frame_idx % 30 == 0:
                await asyncio.sleep(0.001)

        cap.release()
        out_writer.release()

        remux_to_web_mp4(temp_output, output_video_path)

        repo = await get_repository()
        await repo.update_session(job_id, {"processed_video_path": output_video_path})

        job_manager.update_job(job_id, {"processed_video_status": "READY"})
        logger.info(f"Processed video generated for job: {job_id}")

    except Exception as e:
        logger.error(f"Failed to generate processed video for {job_id}: {e}")
        job_manager.update_job(job_id, {"processed_video_status": "FAILED"})

