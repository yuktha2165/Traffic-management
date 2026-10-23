import os
import time
import uuid
import shutil
import asyncio
import logging
from typing import Dict, Any, Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from app.config import settings
from app.services.video_service import extract_video_metadata
from app.services.processing_worker import (
    job_manager, 
    process_video_background_task, 
    generate_processed_video_background_task
)
from app.services.live_stream_service import VideoFileLiveAnalyzer
from app.database.db_factory import get_repository, get_db_mode

logger = logging.getLogger("traffic_app")
router = APIRouter()

@router.post("/videos/upload")
async def upload_video(file: UploadFile = File(...)):
    """Upload a recorded traffic video (.mp4, .avi, .mov, .mkv) and extract metadata."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = os.path.splitext(file.filename)[1].lower()
    allowed_exts = [".mp4", ".avi", ".mov", ".mkv", ".webm"]
    if ext not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format '{ext}'. Allowed formats: {', '.join(allowed_exts)}"
        )

    video_id = f"vid_{uuid.uuid4().hex[:10]}"
    filename = f"{video_id}{ext}"
    saved_path = os.path.join(settings.UPLOAD_DIR, filename)

    try:
        with open(saved_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        metadata = extract_video_metadata(saved_path)
        metadata["video_id"] = video_id
        metadata["video_path"] = saved_path

        # Save preliminary session into repo
        repo = await get_repository()
        await repo.create_session({
            "id": video_id,
            "video_name": file.filename,
            "video_path": saved_path,
            "duration": metadata["duration"],
            "fps": metadata["fps"],
            "resolution": metadata["resolution"],
            "total_frames": metadata["total_frames"],
            "file_size_mb": metadata["size_mb"],
            "status": "UPLOADED",
            "created_at": metadata.get("created_at")
        })

        return JSONResponse(status_code=200, content={
            "success": True,
            "video_id": video_id,
            "metadata": metadata
        })
    except Exception as e:
        if os.path.exists(saved_path):
            os.remove(saved_path)
        raise HTTPException(status_code=500, detail=f"Failed to upload or parse video: {str(e)}")

@router.post("/videos/{video_id}/analyze")

async def analyze_video(
    video_id: str,
    background_tasks: BackgroundTasks,
    confidence_threshold: float = Form(settings.CONFIDENCE_THRESHOLD),
    max_missed_frames: int = Form(settings.MAX_MISSED_FRAMES),
    pixels_per_meter: Optional[float] = Form(settings.PIXELS_PER_METER),
    expected_direction: str = Form(settings.EXPECTED_DIRECTION),
    detection_interval: int = Form(settings.DETECTION_INTERVAL),
    batch_size: int = Form(settings.YOLO_BATCH_SIZE)
):
    """Trigger background analysis on an uploaded video."""
    repo = await get_repository()
    session = await repo.get_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail="Video session not found")

    video_path = session["video_path"]
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Uploaded video file missing on disk")

    output_filename = f"{video_id}_processed.mp4"
    output_path = os.path.join(settings.OUTPUT_DIR, output_filename)

    config = {
        "confidence_threshold": confidence_threshold,
        "max_missed_frames": max_missed_frames,
        "max_association_distance": settings.MAX_ASSOCIATION_DISTANCE,
        "pixels_per_meter": pixels_per_meter if (pixels_per_meter and pixels_per_meter > 0) else None,
        "expected_direction": expected_direction,
        "detection_interval": detection_interval,
        "batch_size": batch_size,
        "yolo_model": settings.YOLO_MODEL
    }

    job_data = job_manager.create_job(video_id, video_path, config)

    # Launch background task
    background_tasks.add_task(
        process_video_background_task,
        job_id=video_id,
        video_path=video_path,
        output_video_path=output_path,
        config=config
    )

    return JSONResponse(status_code=200, content={
        "success": True,
        "message": "Analysis job queued successfully",
        "job_id": video_id,
        "video_id": video_id,
        "status": job_data["status"]
    })

@router.get("/videos/{video_id}")
async def get_video(video_id: str):
    """Retrieve details for a video analysis session."""
    job = job_manager.get_job(video_id)
    repo = await get_repository()
    session = await repo.get_session(video_id)

    if not session and not job:
        raise HTTPException(status_code=404, detail="Video session not found")

    return {
        "success": True,
        "session": session or {},
        "job_status": job or {}
    }

@router.get("/videos/{video_id}/status")
async def get_video_status(video_id: str):
    """Retrieve real-time processing status for a video job."""
    job = job_manager.get_job(video_id)
    if job:
        return {
            "success": True,
            "job": job,
            "video_id": video_id,
            "status": job["status"],
            "progress": job.get("progress", int(job.get("progress_percent", 0))),
            "processed_frames": job.get("processed_frames", job.get("current_frame", 0)),
            "total_frames": job.get("total_frames", 0),
            "vehicles_detected": job.get("vehicles_detected", 0),
            "processing_fps": job.get("processing_fps", 0.0),
            "processing_device": job.get("processing_device", "CPU")
        }

    repo = await get_repository()
    session = await repo.get_session(video_id)
    if session:
        return {
            "success": True,
            "video_id": video_id,
            "status": session.get("status", "COMPLETED"),
            "progress": 100,
            "processed_frames": session.get("total_frames", 0),
            "total_frames": session.get("total_frames", 0),
            "vehicles_detected": session.get("total_vehicles", 0),
            "processing_fps": 30.0,
            "processing_device": session.get("processing_device", "CPU"),
            "job": {
                "id": video_id,
                "status": session.get("status", "COMPLETED"),
                "progress_percent": 100.0 if session.get("status") == "COMPLETED" else 0.0,
                "estimated_remaining_seconds": 0.0
            }
        }

    raise HTTPException(status_code=404, detail="Analysis job not found")

@router.get("/videos/{video_id}/analytics")
async def get_video_analytics(video_id: str):
    """Retrieve time-series and summary traffic metrics for a completed analysis."""
    repo = await get_repository()
    analytics = await repo.get_analytics(video_id)
    if not analytics:
        raise HTTPException(status_code=404, detail="Analytics data not available for this session")

    return {"success": True, "analytics": analytics}

@router.get("/videos/{video_id}/vehicles")
async def get_video_vehicles(video_id: str):
    """Retrieve detailed telemetry for all tracked vehicles in a session."""
    repo = await get_repository()
    vehicles = await repo.get_vehicles(video_id)
    return {"success": True, "vehicles": vehicles, "total": len(vehicles)}

@router.get("/videos/{video_id}/events")
async def get_video_events(video_id: str):
    """Retrieve alerts and traffic violation events for a session."""
    repo = await get_repository()
    events = await repo.get_events(video_id)
    return {"success": True, "events": events, "total": len(events)}

@router.post("/videos/{video_id}/generate-processed-video")
async def generate_processed_video(video_id: str, background_tasks: BackgroundTasks):
    """Trigger background generation of annotated output video."""
    repo = await get_repository()
    session = await repo.get_session(video_id)
    if not session:
        raise HTTPException(status_code=404, detail="Video session not found")

    video_path = session["video_path"]
    output_filename = f"{video_id}_processed.mp4"
    output_path = os.path.join(settings.OUTPUT_DIR, output_filename)

    config = session.get("config", {})
    background_tasks.add_task(
        generate_processed_video_background_task,
        job_id=video_id,
        video_path=video_path,
        output_video_path=output_path,
        config=config
    )

    return JSONResponse(status_code=200, content={
        "success": True,
        "message": "Processed video generation task started",
        "video_id": video_id
    })

@router.get("/videos/{video_id}/processed-video")
async def stream_processed_video(video_id: str):
    """Stream or download the processed video file."""
    output_filename = f"{video_id}_processed.mp4"
    output_path = os.path.join(settings.OUTPUT_DIR, output_filename)

    if not os.path.exists(output_path):
        repo = await get_repository()
        session = await repo.get_session(video_id)
        if session and session.get("processed_video_path") and os.path.exists(session["processed_video_path"]):
            output_path = session["processed_video_path"]
        else:
            raise HTTPException(status_code=404, detail="Processed video file not found. Click 'Generate Processed Video' to create it.")

    return FileResponse(output_path, media_type="video/mp4", filename=output_filename)


@router.get("/history")
async def list_history():
    """Retrieve all historical traffic analysis sessions."""
    repo = await get_repository()
    sessions = await repo.list_sessions()
    return {"success": True, "sessions": sessions, "total": len(sessions)}

@router.delete("/history/{video_id}")
async def delete_history(video_id: str):
    """Delete a session and associated files."""
    repo = await get_repository()
    session = await repo.get_session(video_id)
    if session:
        for p_key in ["video_path", "processed_video_path"]:
            p = session.get(p_key)
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass

    deleted = await repo.delete_session(video_id)
    return {"success": True, "deleted": deleted}

@router.get("/videos/{video_id}/video-file")
async def get_raw_video_file(video_id: str):
    """Stream the raw uploaded MP4 video for HTML5 player playback."""
    repo = await get_repository()
    session = await repo.get_session(video_id)
    if not session or not session.get("video_path") or not os.path.exists(session["video_path"]):
        raise HTTPException(status_code=404, detail="Uploaded video file not found")
    return FileResponse(session["video_path"], media_type="video/mp4")

@router.websocket("/videos/{video_id}/live-analysis/ws")
async def live_analysis_websocket(websocket: WebSocket, video_id: str):
    """
    WebSocket endpoint streaming live YOLO + Kalman tracking telemetry 
    concurrently during HTML5 video playback.
    """
    await websocket.accept()
    repo = await get_repository()
    session = await repo.get_session(video_id)
    if not session or not session.get("video_path") or not os.path.exists(session["video_path"]):
        await websocket.send_json({"error": "Video file not found"})
        await websocket.close()
        return

    video_path = session["video_path"]
    analyzer: Optional[VideoFileLiveAnalyzer] = None
    is_running = False

    try:
        while True:
            # Check for incoming control commands from client (non-blocking if active, or waiting)
            try:
                if is_running:
                    msg = await asyncio.wait_for(websocket.receive_json(), timeout=0.01)
                else:
                    msg = await websocket.receive_json()

                action = msg.get("action", "")
                if action == "start":
                    if analyzer is not None:
                        analyzer.close()
                    analyzer = VideoFileLiveAnalyzer(
                        video_path=video_path,
                        confidence_threshold=float(msg.get("confidence", settings.CONFIDENCE_THRESHOLD)),
                        detection_interval=int(msg.get("interval", settings.DETECTION_INTERVAL)),
                        pixels_per_meter=float(msg.get("pixels_per_meter")) if msg.get("pixels_per_meter") else settings.PIXELS_PER_METER,
                        expected_direction=str(msg.get("direction", settings.EXPECTED_DIRECTION))
                    )
                    is_running = True
                    await websocket.send_json({"type": "status", "status": "STARTED"})

                elif action == "pause":
                    is_running = False
                    await websocket.send_json({"type": "status", "status": "PAUSED"})

                elif action == "resume":
                    is_running = True
                    await websocket.send_json({"type": "status", "status": "RESUMED"})

                elif action == "seek":
                    target_time = float(msg.get("time", 0.0))
                    if analyzer is not None:
                        analyzer.seek_time(target_time)
                    await websocket.send_json({"type": "status", "status": "SEEKED", "time": target_time})

                elif action == "sync":
                    target_time = float(msg.get("time", 0.0))
                    if analyzer is not None:
                        analyzer.sync_time(target_time)

                elif action == "stop":
                    is_running = False
                    if analyzer is not None:
                        analyzer.close()
                        analyzer = None
                    await websocket.send_json({"type": "status", "status": "STOPPED"})

            except asyncio.TimeoutError:
                pass  # Continue streaming next frame telemetry

            if is_running and analyzer is not None:
                step_start = time.time()
                telemetry = analyzer.step_next_frame()
                if telemetry is not None:
                    await websocket.send_json(telemetry)
                    # Adaptive frame pacing to strictly match video native FPS (e.g. 1/30s = ~33.3ms)
                    step_duration = time.time() - step_start
                    frame_target_sec = 1.0 / max(1.0, float(analyzer.fps))
                    sleep_time = max(0.002, frame_target_sec - step_duration)
                    await asyncio.sleep(sleep_time)
                else:
                    # Video completed!
                    is_running = False
                    # Save final summary into DB
                    final_summary = {
                        "total_vehicles": len(analyzer.all_tracked_vehicles),
                        "class_counts": analyzer.analytics_engine.counter.class_counts,
                        "average_speed": analyzer.analytics_engine.get_final_summary({}, list(analyzer.all_tracked_vehicles.values()))["summary"]["average_speed_kmh"],
                        "speed_calibrated": (analyzer.pixels_per_meter is not None and analyzer.pixels_per_meter > 0)
                    }
                    await repo.update_session(video_id, {
                        "status": "COMPLETED",
                        "total_vehicles": final_summary["total_vehicles"],
                        "summary": final_summary
                    })
                    await websocket.send_json({"type": "completed", "summary": final_summary})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"Live analysis WebSocket error for {video_id}: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "error": f"Live analysis failed: {e}"
            })
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if analyzer is not None:
            analyzer.close()

@router.get("/health")
async def health_check():
    """Health check endpoint returning system status and DB mode."""
    return {
        "status": "healthy",
        "service": "Intelligent Traffic Monitoring System",
        "database_mode": get_db_mode(),
        "yolo_model": settings.YOLO_MODEL,
        "default_pixels_per_meter": settings.PIXELS_PER_METER
    }
